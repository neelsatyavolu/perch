/**
 * The memory store: encrypted markdown pages (one record each), an in-RAM search index, the
 * user's memory settings and a change log the Memory page shows as History. Writes run one at a
 * time. Pages are immutable values; every change replaces a page.
 */

import type { KeyStore } from "./keychain";
import { factKey, newPage, parsePage, renderPage, type Fact, type FactSource, type Page } from "./page";
import { RecordFolder } from "./records";
import { cleanText, FILEABLE, isCategory, looksSecret, pagePath, type Category } from "./sanitize";
import { cosine, fuse, MemoryIndex, pageText, type Embedder, type SearchHit, type SearchOptions } from "./search";

export type NewFact = { category: Category; title: string; text: string; expires?: string };
export type AddResult = { added: number; duplicates: number; rejected: { text: string; reason: string }[] };
export type PageSummary = { id: string; path: string; title: string; category: Category; facts: number; updated: string };
export type RetentionDays = 30 | 90 | null;
export type MemorySettings = { extraction: boolean; paused: boolean; historyExtraction: boolean; episodicRetentionDays: RetentionDays };
export type ChangeAction = "add" | "edit" | "delete" | "wipe" | "dream" | "setup";
export type Change = { time: string; action: ChangeAction; path: string; detail: string; source: FactSource };

const PAGES = "pages";
const SETTINGS_KIND = "settings";
const SETTINGS_ID = "0000000000000001";
const CHANGES = "changes";
const DEFAULT_SETTINGS: MemorySettings = { extraction: true, paused: false, historyExtraction: false, episodicRetentionDays: null };
const MAX_FACTS_PER_PAGE = 200;
const MAX_PAGES = 5000;
const CONTEXT_LIMIT = 4000;
const VECTOR_FLOOR = 0.3;

export type StoreOptions = { dir: string; keys: KeyStore; profile: string; now?: () => Date; embedder?: Embedder };

export class MemoryStore {
  private readonly pages = new Map<string, Page>();
  private readonly index = new MemoryIndex();
  private readonly vectors = new Map<string, Float32Array>();
  private config: MemorySettings = DEFAULT_SETTINGS;
  private queue: Promise<unknown> = Promise.resolve();
  /** Records that could not be decrypted at open; shown to the user, never silently dropped. */
  damaged: string[] = [];

  private constructor(
    private readonly folder: RecordFolder,
    private readonly now: () => Date,
    private readonly embedder?: Embedder,
  ) {}

  static async open(opts: StoreOptions): Promise<MemoryStore> {
    const folder = await RecordFolder.open(opts.dir, opts.keys, opts.profile);
    const store = new MemoryStore(folder, opts.now ?? (() => new Date()), opts.embedder);
    const { records, damaged } = await folder.all(PAGES);
    for (const r of records) {
      try {
        store.remember(parsePage(r.text));
      } catch {
        damaged.push(r.id);
      }
    }
    store.damaged = damaged;
    const saved = await folder.get(SETTINGS_KIND, SETTINGS_ID).catch(() => null);
    if (saved) store.config = { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<MemorySettings>) };
    return store;
  }

  /** Runs writes one at a time, so extraction, dreaming and the Memory page never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private remember(page: Page): void {
    this.pages.set(page.id, page);
    this.index.upsert(page);
    this.vectors.delete(page.id);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  list(): PageSummary[] {
    return [...this.pages.values()]
      .map((p) => ({ id: p.id, path: p.path, title: p.title, category: p.category, facts: p.current.length, updated: p.updated }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** A page by id or by path. */
  get(idOrPath: string): Page | null {
    return this.pages.get(idOrPath) ?? [...this.pages.values()].find((p) => p.path === idOrPath) ?? null;
  }

  all(): Page[] {
    return [...this.pages.values()];
  }

  settings(): MemorySettings {
    return this.config;
  }

  updateSettings(patch: Partial<MemorySettings>): Promise<MemorySettings> {
    return this.exclusive(async () => {
      const next = { ...this.config, ...patch };
      for (const key of ["extraction", "paused", "historyExtraction"] as const) {
        if (typeof next[key] !== "boolean") throw new Error(`${key} must be true or false`);
      }
      if (![30, 90, null].includes(next.episodicRetentionDays)) throw new Error("episodic retention must be 30, 90 or never (null)");
      await this.folder.put(SETTINGS_KIND, SETTINGS_ID, JSON.stringify(next));
      this.config = next;
      return next;
    });
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const hits = this.index.search(query, { ...opts, limit: Math.max(opts.limit ?? 8, 20) });
    const limit = opts.limit ?? 8;
    if (!this.embedder) return hits.slice(0, limit);
    const vectorHits = await this.vectorRank(query, opts.categories);
    const byId = new Map(hits.map((h) => [h.id, h]));
    return fuse([hits.map((h) => h.id), vectorHits])
      .slice(0, limit)
      .map((id) => byId.get(id) ?? this.hitFor(id))
      .filter((h): h is SearchHit => h !== null);
  }

  private hitFor(id: string): SearchHit | null {
    const p = this.pages.get(id);
    return p ? { id, path: p.path, title: p.title, category: p.category, snippet: pageText(p).body.slice(0, 160), score: 0 } : null;
  }

  private async vectorRank(query: string, categories?: readonly Category[]): Promise<string[]> {
    const embedder = this.embedder!;
    const pages = [...this.pages.values()].filter((p) => !categories?.length || categories.includes(p.category));
    const missing = pages.filter((p) => !this.vectors.has(p.id));
    if (missing.length) {
      const vecs = await embedder.embed(missing.map((p) => `${p.title}\n${pageText(p).body}`));
      missing.forEach((p, i) => vecs[i] && this.vectors.set(p.id, vecs[i]!));
    }
    const [q] = await embedder.embed([query]);
    if (!q) return [];
    return pages
      .map((p) => ({ id: p.id, score: cosine(q, this.vectors.get(p.id) ?? new Float32Array()) }))
      .filter((s) => s.score >= VECTOR_FLOOR)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.id);
  }

  /** USER.md and MEMORY.md, small enough to go into every chat (spec 8). */
  context(): string {
    const part = (path: string, heading: string) => {
      const facts = this.get(path)?.current ?? [];
      return facts.length ? `${heading}\n${facts.map((f) => `- ${f.text}`).join("\n")}`.slice(0, CONTEXT_LIMIT) : "";
    };
    return [part("USER.md", "About the user (USER.md):"), part("MEMORY.md", "Rules from the user (MEMORY.md):")].filter(Boolean).join("\n\n");
  }

  /** The pages that best match a task, as short text for the system prompt. Empty when nothing matches. */
  async recall(task: string, limit = 4): Promise<string> {
    const categories = FILEABLE.filter((c) => c !== "user" && c !== "rules");
    const hits = await this.search(task, { limit, categories });
    return hits
      .map((h) => {
        const facts = this.pages.get(h.id)?.current.slice(0, 12) ?? [];
        return `${h.path} (${h.title}):\n${facts.map((f) => `- ${f.text}`).join("\n")}`;
      })
      .join("\n\n");
  }

  private pathFor(item: NewFact): string {
    if (item.category === "episodic") return `episodic/${this.stamp().slice(0, 10)}.md`;
    return pagePath(item.category, item.title);
  }

  /** Files facts into their pages. Duplicates are skipped; secrets and bad input are refused. */
  addFacts(items: readonly NewFact[], source: FactSource): Promise<AddResult> {
    return this.exclusive(async () => {
      const result: AddResult = { added: 0, duplicates: 0, rejected: [] };
      const touched = new Map<string, Page>();
      const changes: Change[] = [];
      for (const item of items) {
        const text = cleanText(String(item?.text ?? ""));
        const problem = this.problemWith(item, text);
        if (problem) {
          result.rejected.push({ text, reason: problem });
          continue;
        }
        const path = this.pathFor(item);
        const page = touched.get(path) ?? this.get(path) ?? newPage(path, item.category === "episodic" ? path.slice(9, 19) : item.title, this.stamp());
        if (page.current.some((f) => factKey(f.text) === factKey(text))) {
          result.duplicates++;
          continue;
        }
        if (page.current.length >= MAX_FACTS_PER_PAGE) {
          result.rejected.push({ text, reason: "the page is full" });
          continue;
        }
        const fact: Fact = { text, added: this.stamp(), source, ...(validDate(item.expires) ? { expires: item.expires } : {}) };
        touched.set(path, { ...page, current: [...page.current, fact], updated: this.stamp() });
        changes.push({ time: this.stamp(), action: source === "setup" ? "setup" : "add", path, detail: text, source });
        result.added++;
      }
      for (const page of touched.values()) await this.write(page);
      await this.log(changes);
      return result;
    });
  }

  private problemWith(item: NewFact, text: string): string | null {
    if (!isCategory(item?.category) || !FILEABLE.includes(item.category)) return "unknown category";
    if (!text) return "empty";
    if (looksSecret(text)) return "looks like a secret";
    if (!cleanText(String(item.title ?? "")) && item.category !== "user" && item.category !== "rules" && item.category !== "episodic") return "no title";
    if (this.pages.size >= MAX_PAGES && !this.get(this.pathFor(item))) return "memory is full";
    return null;
  }

  /** Changes one fact's text, or deletes it when text is null. */
  editFact(pageId: string, section: "current" | "history", index: number, text: string | null): Promise<Page> {
    return this.exclusive(async () => {
      const page = this.pages.get(pageId);
      if (!page) throw new Error("no such memory page");
      const facts = page[section];
      const old = facts[index];
      if (!Number.isInteger(index) || !old) throw new Error(`no fact ${index} in ${section}`);
      const clean = text === null ? "" : cleanText(text);
      if (clean && looksSecret(clean)) throw new Error("that looks like a secret; Perch does not keep passwords, keys or codes in memory");
      const next = clean ? facts.map((f, i) => (i === index ? { ...f, text: clean } : f)) : facts.filter((_, i) => i !== index);
      const updated: Page = { ...page, [section]: next, updated: this.stamp() };
      await this.write(updated);
      await this.log([{ time: this.stamp(), action: clean ? "edit" : "delete", path: page.path, detail: clean || old.text, source: "user" }]);
      return updated;
    });
  }

  /** Replaces a whole page (used by dreaming and the Memory page editor). */
  replacePage(page: Page, change: Omit<Change, "time" | "path">): Promise<Page> {
    return this.exclusive(async () => {
      if (!this.pages.has(page.id) && this.get(page.path)) throw new Error(`a page already exists at ${page.path}`);
      const next = { ...page, updated: this.stamp() };
      await this.write(next);
      await this.log([{ ...change, time: this.stamp(), path: page.path }]);
      return next;
    });
  }

  deletePage(id: string, source: FactSource = "user"): Promise<void> {
    return this.exclusive(async () => {
      const page = this.pages.get(id);
      if (!page) return;
      await this.folder.remove(PAGES, id);
      this.pages.delete(id);
      this.index.remove(id);
      this.vectors.delete(id);
      await this.log([{ time: this.stamp(), action: "delete", path: page.path, detail: page.title, source }]);
    });
  }

  /** Deletes every page and the change log, then logs the wipe itself. Settings stay. */
  wipe(): Promise<void> {
    return this.exclusive(async () => {
      await this.folder.removeKind(PAGES);
      await this.folder.removeKind(CHANGES);
      this.pages.clear();
      this.index.clear();
      this.vectors.clear();
      await this.log([{ time: this.stamp(), action: "wipe", path: "", detail: "All memory was deleted", source: "user" }]);
    });
  }

  private async write(page: Page): Promise<void> {
    await this.folder.put(PAGES, page.id, renderPage(page));
    this.remember(page);
  }

  /** The change log, newest first. One encrypted record per day. */
  async changes(limit = 200): Promise<Change[]> {
    const out: Change[] = [];
    for (const id of (await this.folder.ids(CHANGES)).reverse()) {
      const text = await this.folder.get(CHANGES, id).catch(() => null);
      if (text) out.push(...(JSON.parse(text) as Change[]).reverse());
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  private async log(changes: Change[]): Promise<void> {
    if (!changes.length) return;
    const id = this.stamp().slice(0, 10).replace(/-/g, "").padStart(16, "0");
    const existing = await this.folder.get(CHANGES, id).catch(() => null);
    const entries = existing ? (JSON.parse(existing) as Change[]) : [];
    await this.folder.put(CHANGES, id, JSON.stringify([...entries, ...changes]));
  }

  close(): void {
    this.index.close();
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
