/**
 * What "Set up your memory" may read, each behind its own switch: Perch's browsing history and
 * bookmarks (Chromium's files in the profile), open tabs, and past chats. Readers return small
 * rows; the summaries sent to the model hold domains and page titles, never query strings.
 */

import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanText, looksSecret } from "./sanitize";

export type HistoryRow = { url: string; title: string; visits: number; lastVisit: string };
export type Bookmark = { title: string; url: string; folder: string };
export type TabRow = { id: string; title: string; url: string };
export type ChatSummary = { title: string; firstMessage: string; date: string };

/** Chromium stores times as microseconds since 1601-01-01. */
const EPOCH_GAP_MS = 11_644_473_600_000;
const DAY = 86_400_000;
const TITLE_LIMIT = 80;

/** A URL without its query string or fragment (they often hold tokens and search terms). */
export function bareUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(u.hostname)) return null;
    return `${u.origin}${u.pathname === "/" ? "/" : u.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function safeTitle(title: string): string {
  const clean = cleanText(title, TITLE_LIMIT);
  return looksSecret(clean) ? "" : clean;
}

/**
 * Reads Chromium's History file into memory and opens the copy there, so Chrome's lock and WAL
 * are never touched and nothing is written to disk.
 */
export async function readChromiumHistory(profileDir: string, opts: { now: Date; days?: number; limit?: number }): Promise<HistoryRow[]> {
  const bytes = await readFile(join(profileDir, "History")).catch(() => null);
  if (!bytes) return [];
  const since = BigInt(opts.now.getTime() - (opts.days ?? 90) * DAY + EPOCH_GAP_MS) * 1000n;
  const db = Database.deserialize(bytes, true);
  try {
    const rows = db
      .query("SELECT url, title, visit_count AS visits, last_visit_time AS last FROM urls WHERE hidden = 0 AND last_visit_time >= ? ORDER BY visit_count DESC LIMIT ?")
      .all(since, opts.limit ?? 5000) as { url: string; title: string; visits: number; last: number | bigint }[];
    return rows.flatMap((r) => {
      const url = bareUrl(r.url);
      if (!url) return [];
      const ms = Number(BigInt(r.last) / 1000n) - EPOCH_GAP_MS;
      return [{ url, title: safeTitle(r.title ?? ""), visits: Number(r.visits), lastVisit: new Date(ms).toISOString() }];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

type BookmarkNode = { type?: string; name?: string; url?: string; children?: BookmarkNode[] };

export async function readChromiumBookmarks(profileDir: string): Promise<Bookmark[]> {
  const text = await readFile(join(profileDir, "Bookmarks"), "utf8").catch(() => null);
  if (!text) return [];
  let roots: Record<string, BookmarkNode>;
  try {
    roots = (JSON.parse(text) as { roots?: Record<string, BookmarkNode> }).roots ?? {};
  } catch {
    return [];
  }
  const out: Bookmark[] = [];
  const walk = (node: BookmarkNode, folder: string, depth: number) => {
    if (depth > 20) return;
    if (node.type === "url" && node.url) {
      if (bareUrl(node.url)) out.push({ title: safeTitle(node.name ?? ""), url: node.url.split(/[?#]/)[0]!, folder });
      return;
    }
    const path = folder ? `${folder}/${node.name ?? ""}` : node.name ?? "";
    for (const child of node.children ?? []) walk(child, path, depth + 1);
  };
  for (const root of Object.values(roots)) if (root && typeof root === "object") walk(root, "", 0);
  return out;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Visits grouped by site, busiest first, with a few page titles each. */
export function summarizeHistory(rows: readonly HistoryRow[], maxSites = 60): string {
  const sites = new Map<string, { visits: number; titles: string[] }>();
  for (const r of rows) {
    const h = host(r.url);
    if (!h) continue;
    const site = sites.get(h) ?? { visits: 0, titles: [] };
    const titles = r.title && site.titles.length < 3 && !site.titles.includes(r.title) ? [...site.titles, r.title] : site.titles;
    sites.set(h, { visits: site.visits + r.visits, titles });
  }
  return [...sites.entries()]
    .sort((a, b) => b[1].visits - a[1].visits)
    .slice(0, maxSites)
    .map(([h, s]) => `${h}: ${s.visits} visits${s.titles.length ? ` (${s.titles.join("; ")})` : ""}`)
    .join("\n");
}

export function summarizeBookmarks(rows: readonly Bookmark[], max = 150): string {
  return rows.slice(0, max).map((b) => `${b.folder ? `${b.folder}: ` : ""}${b.title || host(b.url)} (${host(b.url)})`).join("\n");
}

export function summarizeTabs(rows: readonly TabRow[], max = 50): string {
  return rows.flatMap((t) => (bareUrl(t.url) ? [`${safeTitle(t.title) || "(untitled)"} (${host(t.url)})`] : [])).slice(0, max).join("\n");
}

export function summarizeChats(rows: readonly ChatSummary[], max = 40): string {
  return rows.slice(0, max).map((c) => `${c.date.slice(0, 10)} ${safeTitle(c.title)}: ${cleanText(c.firstMessage, 200)}`).join("\n");
}
