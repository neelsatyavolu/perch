/**
 * Merge imported bookmarks into a Perch profile's `Bookmarks` file, in Chromium's format, while
 * Perch is closed. Like Chrome's own importer: an empty bar takes the imported bar as is,
 * otherwise the import goes into an "Imported from X" folder. URLs already present anywhere in
 * the file are skipped, so importing the same profile twice adds nothing.
 *
 * The checksum is Chromium's: MD5 over each node in order (bar, other, synced) of its id, its
 * title as UTF-16LE, "url" or "folder", and for URLs the URL.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { toChromium } from "../time";
import { ImportError, type BookmarkNode, type Bookmarks } from "../types";
import { writeAtomically } from "./atomic";

type JsonNode = { id: string; name: string; type: "url" | "folder"; url?: string; children?: JsonNode[]; [k: string]: unknown };
type Roots = { bookmark_bar: JsonNode; other: JsonNode; synced: JsonNode; [k: string]: unknown };

const ROOT_ORDER = ["bookmark_bar", "other", "synced"] as const;

export function bookmarkChecksum(roots: Record<string, unknown>): string {
  const md5 = createHash("md5");
  const visit = (node: JsonNode) => {
    md5.update(node.id, "utf8");
    md5.update(Buffer.from(node.name ?? "", "utf16le"));
    if (node.type === "url") {
      md5.update("url");
      md5.update(node.url ?? "", "utf8");
    } else {
      md5.update("folder");
      for (const child of node.children ?? []) visit(child);
    }
  };
  for (const key of ROOT_ORDER) if (roots[key]) visit(roots[key] as JsonNode);
  return md5.digest("hex");
}

function emptyRoots(now: string): Roots {
  const root = (id: string, name: string, guid: string): JsonNode => ({ children: [], date_added: now, date_last_used: "0", date_modified: "0", guid, id, name, type: "folder" });
  return {
    bookmark_bar: root("1", "Bookmarks bar", "0bc5d13f-2cba-5d74-951f-3f233fe6c908"),
    other: root("2", "Other bookmarks", "82b081ec-3dd3-529c-8475-ab6c344590dd"),
    synced: root("3", "Mobile bookmarks", "4cf2e351-0e85-532b-bb37-df045d8f8d0f"),
  };
}

function walk(node: JsonNode | undefined, fn: (n: JsonNode) => void): void {
  if (!node) return;
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}

function load(path: string, now: string): { json: Record<string, unknown>; roots: Roots } {
  if (!existsSync(path)) return { json: { version: 1 }, roots: emptyRoots(now) };
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    if (!json?.roots?.bookmark_bar || !json.roots.other) throw new Error("no roots");
    return { json, roots: { ...emptyRoots(now), ...json.roots } };
  } catch {
    throw new ImportError("Perch's Bookmarks file could not be read, so nothing was changed.", "unreadable");
  }
}

export type MergeResult = { readonly added: number };

export function mergeBookmarksFile(path: string, imported: Bookmarks, folderTitle: string, nowMs = Date.now()): MergeResult {
  const now = toChromium(nowMs).toString();
  const { json, roots } = load(path, now);
  let nextId = 0;
  const seen = new Set<string>();
  for (const key of Object.keys(roots)) {
    walk(roots[key] as JsonNode, (n) => {
      nextId = Math.max(nextId, Number(n.id) || 0);
      if (n.type === "url" && n.url) seen.add(n.url);
    });
  }
  let added = 0;
  const id = () => String(++nextId);
  const convert = (nodes: readonly BookmarkNode[]): JsonNode[] =>
    nodes.flatMap((n): JsonNode[] => {
      const dateAdded = n.added ? toChromium(n.added).toString() : now;
      if (n.kind === "url") {
        if (!n.url || seen.has(n.url) || n.url.length > 32_768) return [];
        seen.add(n.url);
        added++;
        return [{ date_added: dateAdded, date_last_used: "0", guid: randomUUID(), id: id(), name: n.title, type: "url", url: n.url }];
      }
      const folderId = id();
      const children = convert(n.children);
      return children.length === 0 ? [] : [{ children, date_added: dateAdded, date_last_used: "0", date_modified: now, guid: randomUUID(), id: folderId, name: n.title, type: "folder" }];
    });
  const folder = (children: JsonNode[]): JsonNode[] =>
    children.length === 0 ? [] : [{ children, date_added: now, date_last_used: "0", date_modified: now, guid: randomUUID(), id: id(), name: folderTitle, type: "folder" }];

  const barEmpty = (roots.bookmark_bar.children ?? []).length === 0;
  const bar = barEmpty ? convert(imported.bar) : folder(convert(imported.bar));
  const rest = folder(convert([...imported.other, ...imported.mobile]));
  if (added === 0) return { added: 0 };

  const nextRoots: Roots = {
    ...roots,
    bookmark_bar: { ...roots.bookmark_bar, children: [...(roots.bookmark_bar.children ?? []), ...bar], date_modified: now },
    other: rest.length ? { ...roots.other, children: [...(roots.other.children ?? []), ...rest], date_modified: now } : roots.other,
  };
  const next = { ...json, checksum: bookmarkChecksum(nextRoots), roots: nextRoots, version: 1 };
  writeAtomically(path, JSON.stringify(next, null, 3));
  return { added };
}
