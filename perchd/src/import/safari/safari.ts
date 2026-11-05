/**
 * Safari's own files: ~/Library/Safari/Bookmarks.plist (binary plist) and History.db (SQLite).
 * macOS protects ~/Library/Safari, so these need Full Disk Access; without it every read fails
 * with EPERM, which is turned into an explanation. The export ZIP (export-zip.ts) needs none.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { permissionError, withSqliteCopy } from "../sqlite-copy";
import { fromMac } from "../time";
import { ImportError, isWebUrl, type BookmarkNode, type Bookmarks, type HistoryEntry } from "../types";
import { parseBplist, type PlistValue } from "./bplist";

type Dict = { [key: string]: PlistValue };
const isDict = (v: PlistValue | undefined): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);
const MAX_DEPTH = 64;

function convert(items: PlistValue | undefined, depth: number): BookmarkNode[] {
  if (!Array.isArray(items) || depth > MAX_DEPTH) return [];
  return items.flatMap((item): BookmarkNode[] => {
    if (!isDict(item)) return [];
    if (item.WebBookmarkType === "WebBookmarkTypeLeaf") {
      const url = typeof item.URLString === "string" ? item.URLString : "";
      const uri = isDict(item.URIDictionary) ? item.URIDictionary : {};
      const title = typeof uri.title === "string" ? uri.title : url;
      return isWebUrl(url) ? [{ kind: "url", title, url }] : [];
    }
    if (item.WebBookmarkType === "WebBookmarkTypeList") {
      return [{ kind: "folder", title: typeof item.Title === "string" ? item.Title : "", children: convert(item.Children, depth + 1) }];
    }
    return [];
  });
}

export function parseSafariBookmarks(plist: PlistValue): Bookmarks {
  const top = isDict(plist) && Array.isArray(plist.Children) ? plist.Children.filter(isDict) : [];
  const byTitle = (t: string) => top.find((c) => c.Title === t);
  const bar = convert(byTitle("BookmarksBar")?.Children, 0);
  const menu = convert(byTitle("BookmarksMenu")?.Children, 0);
  const reading = convert(byTitle("com.apple.ReadingList")?.Children, 0);
  const loose = convert(top.filter((c) => !["BookmarksBar", "BookmarksMenu", "com.apple.ReadingList", "History"].includes(String(c.Title))), 0);
  return { bar, other: [...menu, ...loose, ...(reading.length ? [{ kind: "folder" as const, title: "Reading List", children: reading }] : [])], mobile: [] };
}

export function readSafariBookmarks(dir: string): Bookmarks {
  const path = join(dir, "Bookmarks.plist");
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bar: [], other: [], mobile: [] };
    throw permissionError(error, path) ?? error;
  }
  try {
    return parseSafariBookmarks(parseBplist(buf));
  } catch {
    throw new ImportError("Safari's Bookmarks.plist could not be read.", "unreadable");
  }
}

export function readSafariHistory(dir: string): Promise<HistoryEntry[]> {
  return withSqliteCopy(join(dir, "History.db"), (db) =>
    (
      db
        .query(
          `SELECT i.url AS url, i.visit_count AS visit_count, v.title AS title, v.visit_time AS visit_time
           FROM history_items i JOIN history_visits v ON v.history_item = i.id
           WHERE v.visit_time = (SELECT MAX(visit_time) FROM history_visits WHERE history_item = i.id)
           ORDER BY v.visit_time DESC`,
        )
        .all() as { url: string; visit_count: number; title: string | null; visit_time: number }[]
    ).flatMap((r) => {
      const lastVisit = fromMac(r.visit_time);
      return lastVisit !== undefined && isWebUrl(r.url) ? [{ url: r.url, title: r.title ?? "", visitCount: Math.max(1, r.visit_count), typedCount: 0, lastVisit }] : [];
    }),
  );
}

export function countSafariHistory(dir: string): Promise<number> {
  return withSqliteCopy(join(dir, "History.db"), (db) => (db.query("SELECT COUNT(*) AS n FROM history_items WHERE url LIKE 'http%'").get() as { n: number }).n);
}
