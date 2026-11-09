/**
 * Aside's memory files as Perch memory pages. Aside keeps free markdown; a Perch page is a path
 * in a known folder plus one-line facts under "Current" and "History" (src/memory/page.ts). So
 * each file's lines become facts: a long line is split at word breaks, a section heading is put in
 * front of the lines under it, and a file with more facts than a page holds continues on "-2",
 * "-3" pages. Lines that look like a password or key are left out, as everywhere in memory.
 */

import { factKey } from "../../memory/page";
import { categoryOf, cleanText, isCategory, looksSecret, MAX_FACT, MAX_TITLE, slugify } from "../../memory/sanitize";
import type { NewPage } from "../../memory/store";
import type { TextFile } from "../../import/types";

/** The store's limit for each list on a page (MAX_FACTS_PER_PAGE in src/memory/store.ts). */
const PAGE_FACTS = 200;
const MAX_CONTEXT = 80;
const TOP_PAGES: ReadonlySet<string> = new Set(["USER.md", "MEMORY.md"]);
/** Aside folders Perch names differently. A folder Perch does not have goes under concepts. */
const FOLDERS: Readonly<Record<string, string>> = { users: "people", "dreaming-history": "log" };
const OTHER_FOLDER = "concepts";

export type MappedFile = { readonly pages: readonly NewPage[]; readonly secrets: number };

/** Where a file goes in Perch, or null for one Perch has no page for (TAXONOMY.md, not markdown). */
export function pagePathFor(path: string): string | null {
  if (TOP_PAGES.has(path)) return path;
  if (!path.endsWith(".md") || path === "TAXONOMY.md") return null;
  const parts = path.slice(0, -3).split("/").filter(Boolean);
  const first = parts[0] ?? "";
  const known = FOLDERS[first] ?? (isCategory(first) && first !== "user" && first !== "rules" ? first : null);
  const folder = parts.length > 1 && known ? known : OTHER_FOLDER;
  const name = parts.length > 1 && known ? parts.slice(1) : parts;
  const mapped = `${folder}/${slugify(name.join("-"))}.md`;
  return categoryOf(mapped) ? mapped : null;
}

type Head = { readonly title?: string; readonly aliases: readonly string[]; readonly body: string };

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Aside's frontmatter: `title`, and `aliases` as `[a, b]` or a `- a` list. */
function head(text: string): Head {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { aliases: [], body: text };
  const lines = match[1]!.split(/\r?\n/);
  const title = lines.map((l) => /^title:\s*(.+)$/.exec(l)?.[1]).find(Boolean);
  const at = lines.findIndex((l) => /^aliases:/.test(l));
  const inline = at < 0 ? "" : lines[at]!.slice("aliases:".length).trim();
  const listed = at < 0 ? [] : lines.slice(at + 1).filter((_, i, rest) => rest.slice(0, i + 1).every((l) => /^\s+-\s/.test(l)));
  const aliases = inline ? inline.replace(/^\[|\]$/g, "").split(",") : listed.map((l) => l.replace(/^\s+-\s/, ""));
  return { ...(title ? { title: unquote(title) } : {}), aliases: aliases.map(unquote).filter(Boolean), body: match[2]! };
}

/** One line as facts of at most MAX_FACT characters, split at word breaks, each with the heading in front. */
function chunks(context: string, text: string): string[] {
  const prefix = context ? `${context}: ` : "";
  const room = MAX_FACT - prefix.length;
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ").flatMap((w) => w.match(new RegExp(`.{1,${room}}`, "gu")) ?? [])) {
    if (line && line.length + 1 + word.length > room) {
      out.push(prefix + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...out, prefix + line] : out;
}

type Lists = { readonly title?: string; readonly current: readonly string[]; readonly history: readonly string[]; readonly secrets: number };

/** The body's lines as facts. "## History" starts the history list; any other "##" goes back to current. */
function facts(body: string): Lists {
  const lists = { current: [] as string[], history: [] as string[] };
  const seen = new Set<string>();
  let title: string | undefined;
  let section: "current" | "history" = "current";
  let context = "";
  let secrets = 0;
  for (const raw of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw.trim());
    if (heading) {
      const text = cleanText(heading[2]!, MAX_CONTEXT);
      const named = /^(current|history)\b/i.exec(text)?.[1]?.toLowerCase() as "current" | "history" | undefined;
      const isTitle = heading[1] === "#" && title === undefined;
      if (isTitle) title = text;
      else if (heading[1] === "##") section = named ?? "current";
      context = isTitle || (heading[1] === "##" && named) ? "" : text;
      continue;
    }
    const text = cleanText(raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\s*>\s?/, ""), Number.MAX_SAFE_INTEGER);
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    for (const fact of chunks(context, text)) {
      const key = `${section}:${factKey(fact)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (looksSecret(fact)) secrets++;
      else lists[section].push(fact);
    }
  }
  return { ...(title ? { title } : {}), ...lists, secrets };
}

const titleFromPath = (path: string) => path.slice(path.lastIndexOf("/") + 1, -3).replace(/[-_]+/g, " ").trim();

/** `people/ada.md` and its continuation pages `people/ada-2.md`, …; the slug is cut to keep the path valid. */
function partPath(path: string, part: number): string {
  if (part === 0) return path;
  const suffix = `-${part + 1}`;
  return `${path.slice(0, -3).slice(0, 80 + path.indexOf("/") + 1 - suffix.length)}${suffix}.md`;
}

/** The pages one Aside memory file becomes, or null when Perch has no place for it or it says nothing. */
export function pagesFromAside(file: TextFile): MappedFile | null {
  const path = pagePathFor(file.path);
  if (!path) return null;
  const front = head(file.text);
  const lists = facts(front.body);
  const title = cleanText(front.title ?? lists.title ?? titleFromPath(file.path), MAX_TITLE);
  const known = front.aliases.length ? chunks("", cleanText(`Also known as: ${front.aliases.join(", ")}`)).filter((f) => !looksSecret(f)) : [];
  const current = [...known, ...lists.current];
  if (current.length + lists.history.length === 0) return null;
  // USER.md and MEMORY.md are single pages by name, so what does not fit on them is left out.
  const parts = TOP_PAGES.has(path) ? 1 : Math.max(Math.ceil(current.length / PAGE_FACTS), Math.ceil(lists.history.length / PAGE_FACTS));
  const pages = Array.from({ length: parts }, (_, i): NewPage => ({
    path: partPath(path, i),
    title: i === 0 ? title : cleanText(`${title} (${i + 1})`, MAX_TITLE),
    current: current.slice(i * PAGE_FACTS, (i + 1) * PAGE_FACTS),
    history: lists.history.slice(i * PAGE_FACTS, (i + 1) * PAGE_FACTS),
  }));
  return { pages: pages.filter((p) => p.current.length + (p.history?.length ?? 0) > 0), secrets: lists.secrets };
}
