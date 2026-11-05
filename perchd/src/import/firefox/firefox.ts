/**
 * Firefox and Zen profiles: bookmarks and history from places.sqlite, cookies from
 * cookies.sqlite, open windows from the mozLz4-compressed session store.
 * Saved passwords need NSS (key4.db) and are not read here; the wizard offers the CSV route.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { withSqliteCopy } from "../sqlite-copy";
import { fromUnixMicros } from "../time";
import { isWebUrl, type BookmarkNode, type Bookmarks, type Cookie, type HistoryEntry, type SessionWindow, type TabGroup } from "../types";
import { decodeMozLz4 } from "./mozlz4";

type BookmarkRow = { id: number; type: number; parent: number; position: number; title: string | null; url: string | null; dateAdded: number | null; guid: string };

const MAX_DEPTH = 64;

export function readFirefoxBookmarks(profile: string): Promise<Bookmarks> {
  return withSqliteCopy(join(profile, "places.sqlite"), (db) => {
    const rows = db
      .query("SELECT b.id, b.type, b.parent, b.position, b.title, p.url, b.dateAdded, b.guid FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position")
      .all() as BookmarkRow[];
    const byParent = new Map<number, BookmarkRow[]>();
    for (const r of rows) {
      const siblings = byParent.get(r.parent) ?? [];
      siblings.push(r);
      byParent.set(r.parent, siblings);
    }
    const build = (parent: number, depth: number): BookmarkNode[] =>
      depth > MAX_DEPTH
        ? []
        : (byParent.get(parent) ?? []).flatMap((r): BookmarkNode[] => {
            const added = fromUnixMicros(r.dateAdded);
            if (r.type === 1 && r.url && isWebUrl(r.url)) return [{ kind: "url", title: r.title ?? r.url, url: r.url, ...(added ? { added } : {}) }];
            if (r.type === 2) return [{ kind: "folder", title: r.title ?? "", children: build(r.id, depth + 1), ...(added ? { added } : {}) }];
            return [];
          });
    const root = (guid: string) => rows.find((r) => r.guid === guid);
    const children = (guid: string) => {
      const r = root(guid);
      return r ? build(r.id, 0) : [];
    };
    return { bar: children("toolbar_____"), other: [...children("menu________"), ...children("unfiled_____")], mobile: children("mobile______") };
  });
}

const HISTORY_WHERE = "hidden = 0 AND last_visit_date > 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')";

export function readFirefoxHistory(profile: string): Promise<HistoryEntry[]> {
  return withSqliteCopy(join(profile, "places.sqlite"), (db) =>
    (db.query(`SELECT url, title, visit_count, typed, last_visit_date FROM moz_places WHERE ${HISTORY_WHERE} ORDER BY last_visit_date DESC`).all() as {
      url: string;
      title: string | null;
      visit_count: number;
      typed: number;
      last_visit_date: number;
    }[]).flatMap((r) => {
      const lastVisit = fromUnixMicros(r.last_visit_date);
      return lastVisit ? [{ url: r.url, title: r.title ?? "", visitCount: Math.max(1, r.visit_count), typedCount: r.typed ? 1 : 0, lastVisit }] : [];
    }),
  );
}

export function countFirefoxHistory(profile: string): Promise<number> {
  return withSqliteCopy(join(profile, "places.sqlite"), (db) => (db.query(`SELECT COUNT(*) AS n FROM moz_places WHERE ${HISTORY_WHERE}`).get() as { n: number }).n);
}

const SAME_SITE: Record<number, Cookie["sameSite"]> = { 0: "None", 1: "Lax", 2: "Strict" };

export async function readFirefoxCookies(profile: string, now = Date.now()): Promise<Cookie[]> {
  const path = join(profile, "cookies.sqlite");
  if (!existsSync(path)) return [];
  return withSqliteCopy(path, (db) =>
    // Container tabs (originAttributes) stay behind: Perch has no containers to put them in.
    (db.query("SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies WHERE originAttributes = ''").all() as {
      name: string;
      value: string;
      host: string;
      path: string;
      expiry: number;
      isSecure: number;
      isHttpOnly: number;
      sameSite: number;
    }[]).flatMap((r): Cookie[] => {
      // Firefox 13x moved expiry from seconds to milliseconds.
      const expires = r.expiry > 1e11 ? Math.floor(r.expiry / 1000) : r.expiry;
      if (expires * 1000 <= now) return [];
      return [{ name: r.name, value: r.value, domain: r.host, path: r.path || "/", expires, secure: r.isSecure === 1, httpOnly: r.isHttpOnly === 1, ...(SAME_SITE[r.sameSite] ? { sameSite: SAME_SITE[r.sameSite] } : {}) }];
    }),
  );
}

export function countFirefoxCookies(profile: string): Promise<number> {
  const path = join(profile, "cookies.sqlite");
  if (!existsSync(path)) return Promise.resolve(0);
  return withSqliteCopy(path, (db) => (db.query("SELECT COUNT(*) AS n FROM moz_cookies WHERE originAttributes = ''").get() as { n: number }).n);
}

/** The newest of the clean-exit store and the running-session recovery file. */
export function readFirefoxSession(profile: string): SessionWindow[] {
  const candidates = [join(profile, "sessionstore.jsonlz4"), join(profile, "sessionstore-backups", "recovery.jsonlz4"), join(profile, "sessionstore-backups", "previous.jsonlz4")]
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const path of candidates) {
    try {
      return parseFirefoxSession(JSON.parse(decodeMozLz4(readFileSync(path)).toString("utf8")));
    } catch {
      // A damaged file: try the next one.
    }
  }
  return [];
}

export function parseFirefoxSession(json: any): SessionWindow[] {
  const windows: any[] = Array.isArray(json?.windows) ? json.windows : [];
  return windows.flatMap((w): SessionWindow[] => {
    const groups: TabGroup[] = (Array.isArray(w?.groups) ? w.groups : []).map((g: any) => ({ id: String(g.id), title: String(g.name ?? ""), color: String(g.color ?? "grey"), collapsed: Boolean(g.collapsed) }));
    const selectedRaw = Number(w?.selected ?? 1) - 1;
    const kept = (Array.isArray(w?.tabs) ? w.tabs : []).flatMap((t: any, i: number) => {
      const entries: any[] = Array.isArray(t?.entries) ? t.entries : [];
      const entry = entries[Math.min(Math.max(Number(t?.index ?? entries.length) - 1, 0), entries.length - 1)];
      const url = typeof entry?.url === "string" ? entry.url : "";
      if (t?.hidden || !isWebUrl(url)) return [];
      const groupId = t.groupId !== undefined && groups.some((g) => g.id === String(t.groupId)) ? String(t.groupId) : undefined;
      return [{ i, tab: { url, title: typeof entry.title === "string" ? entry.title : "", pinned: Boolean(t.pinned), ...(groupId ? { groupId } : {}) } }];
    }) as { i: number; tab: SessionWindow["tabs"][number] }[];
    if (kept.length === 0) return [];
    const tabs = kept.map((k) => k.tab);
    const used = new Set(tabs.map((t) => t.groupId).filter(Boolean));
    // The selected tab's position among the tabs that were kept (or the nearest one before it).
    const selected = Math.max(0, kept.filter((k) => k.i <= selectedRaw).length - 1);
    return [{ tabs, selected, groups: groups.filter((g) => used.has(g.id)) }];
  });
}
