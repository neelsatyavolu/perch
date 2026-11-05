/** Chromium's `Bookmarks` JSON file. */

import { readFileSync } from "node:fs";
import { permissionError } from "../sqlite-copy";
import { fromChromium } from "../time";
import { ImportError, type BookmarkNode, type Bookmarks } from "../types";

const MAX_DEPTH = 64;

export function readChromeBookmarks(path: string): Bookmarks {
  let json: any;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { bar: [], other: [], mobile: [] };
    throw permissionError(error, path) ?? new ImportError("The Bookmarks file could not be read.", "unreadable");
  }
  const roots = json?.roots ?? {};
  return { bar: children(roots.bookmark_bar, 0), other: children(roots.other, 0), mobile: children(roots.synced, 0) };
}

function children(node: any, depth: number): BookmarkNode[] {
  if (!node || !Array.isArray(node.children) || depth > MAX_DEPTH) return [];
  return node.children.flatMap((child: any): BookmarkNode[] => {
    const title = typeof child?.name === "string" ? child.name : "";
    const added = fromChromium(safeBigInt(child?.date_added));
    if (child?.type === "url" && typeof child.url === "string" && child.url) return [{ kind: "url", title, url: child.url, added }];
    if (child?.type === "folder") return [{ kind: "folder", title, children: children(child, depth + 1), added }];
    return [];
  });
}

function safeBigInt(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return undefined;
  return BigInt(value);
}
