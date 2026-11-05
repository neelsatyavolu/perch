/**
 * A memory page: one markdown document about one subject (spec 8), with frontmatter and
 * "Current" and "History" sections. Each fact line carries its date, source and optional expiry
 * in an HTML comment, so the page stays readable markdown.
 */

import { categoryOf, cleanText, MAX_TITLE, type Category } from "./sanitize";

export type FactSource = "chat" | "setup" | "user" | "dreaming" | "import" | "agent";
export type Fact = { readonly text: string; readonly added: string; readonly source: FactSource; readonly expires?: string };
export type Page = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly category: Category;
  readonly current: readonly Fact[];
  readonly history: readonly Fact[];
  readonly created: string;
  readonly updated: string;
};

const SOURCES: readonly FactSource[] = ["chat", "setup", "user", "dreaming", "import", "agent"];
const ID = /^[a-f0-9]{32}$/;
const FIXED_TITLES: Record<string, string> = { "USER.md": "About you", "MEMORY.md": "Rules for Perch" };

export function newId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

export function newPage(path: string, title: string, now: string, id = newId()): Page {
  const category = categoryOf(path);
  if (!category) throw new Error(`"${path}" is not a memory page path`);
  const fixed = FIXED_TITLES[path];
  return { id, path, title: fixed ?? (cleanText(title, MAX_TITLE) || path), category, current: [], history: [], created: now, updated: now };
}

function renderFact(f: Fact): string {
  const meta = [`added=${f.added}`, `source=${f.source}`, ...(f.expires ? [`expires=${f.expires}`] : [])].join(" ");
  return `- ${cleanText(f.text)} <!-- ${meta} -->`;
}

export function renderPage(page: Page): string {
  const lines = [
    "---",
    `id: ${page.id}`,
    `path: ${page.path}`,
    `title: ${cleanText(page.title, MAX_TITLE)}`,
    `created: ${page.created}`,
    `updated: ${page.updated}`,
    "---",
    `# ${cleanText(page.title, MAX_TITLE)}`,
    "",
    "## Current",
    ...page.current.map(renderFact),
  ];
  if (page.history.length) lines.push("", "## History", ...page.history.map(renderFact));
  return `${lines.join("\n")}\n`;
}

function parseFact(line: string, fallbackDate: string): Fact | null {
  const body = line.replace(/^\s*[-*]\s+/, "");
  const meta = /\s*<!--(.*?)-->\s*$/.exec(body);
  const text = cleanText(meta ? body.slice(0, meta.index) : body);
  if (!text) return null;
  const fields = new Map((meta?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map((kv) => kv.split("=", 2) as [string, string]));
  const source = fields.get("source") as FactSource | undefined;
  const expires = fields.get("expires");
  return {
    text,
    added: fields.get("added") ?? fallbackDate,
    source: source && SOURCES.includes(source) ? source : "user",
    ...(expires && /^\d{4}-\d{2}-\d{2}/.test(expires) ? { expires } : {}),
  };
}

export function parsePage(markdown: string): Page {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error("memory page has no frontmatter");
  const front = new Map(
    match[1]!.split("\n").flatMap((l) => {
      const i = l.indexOf(":");
      return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]] : [];
    }),
  );
  const id = front.get("id") ?? "";
  const path = front.get("path") ?? "";
  const category = categoryOf(path);
  if (!ID.test(id) || !category) throw new Error("memory page has a bad id or path");
  const updated = front.get("updated") ?? new Date(0).toISOString();
  const current: Fact[] = [];
  const history: Fact[] = [];
  let section: Fact[] | null = null;
  for (const line of match[2]!.split("\n")) {
    if (/^##\s+current\b/i.test(line)) section = current;
    else if (/^##\s+history\b/i.test(line)) section = history;
    else if (/^#/.test(line)) section = null;
    else if (section && /^\s*[-*]\s+/.test(line)) {
      const fact = parseFact(line, updated);
      if (fact) section.push(fact);
    }
  }
  return { id, path, title: front.get("title") || path, category, current, history, created: front.get("created") ?? updated, updated };
}

/** Facts compare equal when they say the same words, ignoring case and punctuation. */
export function factKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
