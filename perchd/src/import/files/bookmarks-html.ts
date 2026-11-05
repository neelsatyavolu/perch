/**
 * The Netscape bookmarks HTML every browser exports (Chrome, Safari's export ZIP, Firefox).
 * Folders are <DT><H3>, links are <DT><A HREF>, and each folder's contents sit in a <DL>.
 * The toolbar folder (PERSONAL_TOOLBAR_FOLDER, or Safari's "Favorites") becomes the bar.
 */

import { isWebUrl, type BookmarkNode, type Bookmarks } from "../types";

const TOKEN = /<h3\b([^>]*)>([\s\S]*?)<\/h3>|<a\b([^>]*)>([\s\S]*?)<\/a>|<dl\b[^>]*>|<\/dl>/gi;
const BAR_TITLES = new Set(["favorites", "favourites", "bookmarks bar", "bookmarks toolbar", "favorites bar"]);
const MAX_DEPTH = 64;

export function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function safeChar(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
}

type Frame = { title: string; isBar: boolean; children: BookmarkNode[]; added?: number };

export function parseBookmarksHtml(html: string): Bookmarks {
  const root: Frame = { title: "", isBar: false, children: [] };
  const stack: Frame[] = [];
  let pending: Frame | undefined;
  let bar: BookmarkNode[] | undefined;
  for (const m of html.matchAll(TOKEN)) {
    const tag = m[0].slice(0, 3).toLowerCase();
    if (m[1] !== undefined) {
      const title = decodeEntities(m[2] ?? "");
      const added = Number(attr(m[1], "add_date")) * 1000 || undefined;
      pending = { title, isBar: attr(m[1], "personal_toolbar_folder") === "true" || (stack.length <= 1 && BAR_TITLES.has(title.toLowerCase())), children: [], added };
    } else if (m[3] !== undefined) {
      const url = attr(m[3], "href") ?? "";
      const added = Number(attr(m[3], "add_date")) * 1000 || undefined;
      if (isWebUrl(url)) (stack.at(-1) ?? root).children.push({ kind: "url", title: decodeEntities(m[4] ?? ""), url, ...(added ? { added } : {}) });
    } else if (tag === "<dl") {
      // The first <DL> is the file's root list; later ones belong to the folder just named.
      if (stack.length === 0) stack.push(root);
      else if (stack.length < MAX_DEPTH) stack.push(pending ?? { title: "", isBar: false, children: [] });
      pending = undefined;
    } else if (stack.length > 1) {
      const done = stack.pop()!;
      const node: BookmarkNode = { kind: "folder", title: done.title, children: done.children, ...(done.added ? { added: done.added } : {}) };
      if (done.isBar && !bar) bar = done.children;
      else stack.at(-1)!.children.push(node);
    }
  }
  return { bar: bar ?? [], other: root.children, mobile: [] };
}
