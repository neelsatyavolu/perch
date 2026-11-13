/**
 * The memory store: encrypted markdown pages (one record each), an in-RAM search index, the
 * user's memory settings and a change log the Memory page shows as History. Writes run one at a
 * time. Pages are immutable values; every change replaces a page.
 */

import type { KeyStore } from "./keychain";
import { factKey, newPage, parsePage, renderPage, type Fact, type FactSource, type Page } from "./page";
import { randomBytes } from "node:crypto";
import { RecordFolder } from "./records";
import { categoryOf, cleanText, FILEABLE, isCategory, looksSecret, pagePath, type Category } from "./sanitize";
import { cosine, fuse, MemoryIndex, pageText, type Embedder, type SearchHit, type SearchOptions } from "./search";
import { DEFAULT_TAXONOMY, MAX_TAXONOMY, TAXONOMY_PATH } from "./taxonomy";
import { RECALL_LIMIT, renderRecall, scoreFacts, siteFacts, sitePageFor } from "./recall";

export type NewFact = { category: Category; title: string; text: string; expires?: string };
export type AddResult = { added: number; duplicates: number; rejected: { text: string; reason: string }[]; paths: string[] };
/** A whole page to add: its path, title and fact texts. */
export type NewPage = { readonly path: string; readonly title: string; readonly current: readonly string[]; readonly history?: readonly string[] };
export type AddPagesResult = { readonly added: readonly string[]; readonly skipped: readonly { readonly path: string; readonly reason: string }[] };
export type PageSummary ={ id: string; path: string; title: string; category: Category; facts: number; updated: string };
export type RetentionDays = 30 | 90 | null;
/** `dreaming`: the nightly tidy (spec 8) runs; it never runs while extraction is off or memory is paused. */
export type MemorySettings = { extraction: boolean; paused: boolean; dreaming: boolean; episodicRetentionDays: RetentionDays };
export type ChangeAction = "add" | "edit" | "delete" | "wipe" | "dream" | "setup" | "revert";
/** `snapshot` names the page as it was before this change, kept so the change can be undone. */
export type Change = { time: string; action: ChangeAction; path: string; detail: string; source: FactSource; snapshot?: string };
/** A page as it was before a change: null when the change created it. */
type Snapshot = { pageId: string; path: string; before: string | null };

const PAGES = "pages";
const SETTINGS_KIND = "settings";
const SETTINGS_ID = "0000000000000001";
const CHANGES = "changes";
const SNAPSHOTS = "snapshots";
/** Larger pages are not kept for undo (a page's limit is far below this). */
const MAX_SNAPSHOT = 400_000;
const TAXONOMY_KIND = "taxonomy";
const DEFAULT_SETTINGS: MemorySettings = { extraction: true, paused: false, dreaming: true, episodicRetentionDays: null };
/** Used when saved settings cannot be read: never turn memory back on that the user may have turned off. */
const SAFE_SETTINGS: MemorySettings = { extraction: false, paused: true, dreaming: false, episodicRetentionDays: null };
/** How damaged settings are listed in `damaged`. */
const DAMAGED_SETTINGS = "settings";
const MAX_FACTS_PER_PAGE = 200;
const MAX_PAGES = 5000;
const CONTEXT_LIMIT = 4000;
const VECTOR_FLOOR = 0.3;

export type StoreOptions = { dir: string; keys: KeyStore; profile: string; now?: () => Date; embedder?: Embedder; createKey?: boolean };

export class MemoryStore {
  private readonly pages = new Map<string, Page>();
  private readonly index = new MemoryIndex();
  private readonly vectors = new Map<string, Float32Array>();
  private config: MemorySettings = DEFAULT_SETTINGS;
  /** The user's own TAXONOMY.md, or null for the default. */
  private customTaxonomy: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Records that could not be decrypted at open; shown to the user, never silently dropped. */
  damaged: string[] = [];

  private constructor(
    private readonly folder: RecordFolder,
    private readonly now: () => Date,
    private readonly embedder?: Embedder,
  ) {}

  static async open(opts: StoreOptions): Promise<MemoryStore> {
    const folder = await RecordFolder.open(opts.dir, opts.keys, opts.profile, { createKey: opts.createKey });
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
    try {
      const saved = await folder.get(SETTINGS_KIND, SETTINGS_ID);
      if (saved) store.config = { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<MemorySettings>) };
    } catch {
      store.config = SAFE_SETTINGS;
      store.damaged = [...store.damaged, DAMAGED_SETTINGS];
    }
    try {
      store.customTaxonomy = await folder.get(TAXONOMY_KIND, SETTINGS_ID);
    } catch {
      store.damaged = [...store.damaged, TAXONOMY_KIND];
    }
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
      for (const key of ["extraction", "paused", "dreaming"] as const) {
        if (typeof next[key] !== "boolean") throw new Error(`${key} must be true or false`);
      }
      if (![30, 90, null].includes(next.episodicRetentionDays)) throw new Error("episodic retention must be 30, 90 or never (null)");
      await this.folder.put(SETTINGS_KIND, SETTINGS_ID, JSON.stringify(next));
      this.config = next;
      this.damaged = this.damaged.filter((d) => d !== DAMAGED_SETTINGS);
      return next;
    });
  }

  /** TAXONOMY.md: the filing rules, the user's own when they changed them. */
  taxonomy(): string {
    return this.customTaxonomy ?? DEFAULT_TAXONOMY;
  }

  isTaxonomyCustom(): boolean {
    return this.customTaxonomy !== null;
  }

  /** Saves the user's TAXONOMY.md, or goes back to the default when text is null. Wiping memory keeps it. */
  setTaxonomy(text: string | null): Promise<string> {
    return this.exclusive(async () => {
      const clean = text === null ? null : text.trim();
      if (clean !== null && (!clean || clean.length > MAX_TAXONOMY)) throw new Error(`TAXONOMY.md must have 1 to ${MAX_TAXONOMY} characters`);
      if (clean === null) await this.folder.remove(TAXONOMY_KIND, SETTINGS_ID);
      else await this.folder.put(TAXONOMY_KIND, SETTINGS_ID, clean);
      this.customTaxonomy = clean;
      this.damaged = this.damaged.filter((d) => d !== TAXONOMY_KIND);
      await this.log([{ time: this.stamp(), action: "edit", path: TAXONOMY_PATH, detail: clean === null ? "Filing rules reset to the default" : "Filing rules changed", source: "user" }]);
      return this.taxonomy();
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

  /**
   * What memory brings in for one user message (recall.ts): the facts that match it well, and the
   * site page for the tab the user is on. `exclude` holds facts already shown in this chat; the
   * keys of what this call shows come back so the caller can add them.
   */
  recallFor(message: string, opts: { url?: string; exclude?: ReadonlySet<string>; now?: number } = {}): { text: string; keys: string[] } {
    const exclude = opts.exclude ?? new Set<string>();
    const categories = FILEABLE.filter((c) => c !== "user" && c !== "rules");
    const sitePage = opts.url ? sitePageFor([...this.pages.values()], opts.url) : undefined;
    const site = sitePage ? { host: new URL(opts.url!).hostname.replace(/^www\./, ""), page: sitePage, items: siteFacts(sitePage, exclude) } : undefined;
    const siteKeys = new Set(site?.items.map((i) => i.key) ?? []);
    const items = scoreFacts(this.index.searchFacts(message, { categories, limit: 40 }), message, opts.now ?? Date.now())
      .filter((i) => !exclude.has(i.key) && !siteKeys.has(i.key))
      .slice(0, RECALL_LIMIT);
    return { text: renderRecall(items, site), keys: [...items.map((i) => i.key), ...siteKeys] };
  }

  private pathFor(item: NewFact): string {
    if (item.category === "episodic") return `episodic/${this.stamp().slice(0, 10)}.md`;
    return pagePath(item.category, item.title);
  }

  /** Files facts into their pages. Duplicates are skipped; secrets and bad input are refused. */
  addFacts(items: readonly NewFact[], source: FactSource): Promise<AddResult> {
    return this.exclusive(async () => {
      const result: AddResult = { added: 0, duplicates: 0, rejected: [], paths: [] };
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
      result.paths.push(...touched.keys());
      await this.log(changes);
      return result;
    });
  }

  /**
   * Adds whole new pages in one pass (an import): one record per page, one change-log write for
   * all of them. A page whose path is taken is left as it is; bad paths, secrets, empty and
   * oversized pages are refused. Nothing existing is ever replaced.
   */
  addPages(items: readonly NewPage[], source: FactSource, detail: string): Promise<AddPagesResult> {
    return this.exclusive(async () => {
      const taken = new Set([...this.pages.values()].map((p) => p.path));
      const added: Page[] = [];
      const skipped: { path: string; reason: string }[] = [];
      for (const item of items) {
        const page = taken.has(item.path) ? "a page is already there" : this.pageFrom(item, source, taken.size);
        if (typeof page === "string") skipped.push({ path: String(item.path), reason: page });
        else {
          taken.add(page.path);
          added.push(page);
        }
      }
      for (const page of added) await this.write(page);
      await this.log(added.map((p) => ({ time: p.created, action: "add", path: p.path, detail, source })));
      return { added: added.map((p) => p.path), skipped };
    });
  }

  /** The page an import item makes, or why it cannot be one. */
  private pageFrom(item: NewPage, source: FactSource, count: number): Page | string {
    if (count >= MAX_PAGES) return "memory is full";
    if (typeof item.path !== "string" || !categoryOf(item.path)) return "not a memory page path";
    const now = this.stamp();
    const facts = (texts: readonly string[]): Fact[] => texts.map((t) => cleanText(String(t))).filter(Boolean).map((text) => ({ text, added: now, source }));
    const current = facts(item.current);
    const history = facts(item.history ?? []);
    if (current.length + history.length === 0) return "empty";
    if (current.length > MAX_FACTS_PER_PAGE || history.length > MAX_FACTS_PER_PAGE) return "too many facts";
    if ([...current, ...history].some((f) => looksSecret(f.text))) return "looks like a secret";
    return { ...newPage(item.path, String(item.title ?? ""), now), current, history };
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

  /**
   * Replaces a whole page (used by dreaming). With `expectedUpdated`, nothing is written and null
   * comes back when the page changed since it was read, so a slow pass never overwrites newer facts.
   */
  replacePage(page: Page, change: Omit<Change, "time" | "path">, expectedUpdated?: string): Promise<Page | null> {
    return this.exclusive(async () => {
      if (expectedUpdated !== undefined && this.pages.get(page.id)?.updated !== expectedUpdated) return null;
      if (!this.pages.has(page.id) && this.get(page.path)) throw new Error(`a page already exists at ${page.path}`);
      const next = { ...page, updated: this.stamp() };
      await this.write(next);
      await this.log([{ ...change, time: this.stamp(), path: page.path }]);
      return next;
    });
  }

  /** Deletes a page. With `expectedUpdated`, returns false and keeps the page if it changed since it was read. */
  deletePage(id: string, source: FactSource = "user", expectedUpdated?: string): Promise<boolean> {
    return this.exclusive(async () => {
      const page = this.pages.get(id);
      if (!page || (expectedUpdated !== undefined && page.updated !== expectedUpdated)) return false;
      await this.snapshot(id, page.path);
      await this.folder.remove(PAGES, id);
      this.pages.delete(id);
      this.index.remove(id);
      this.vectors.delete(id);
      await this.log([{ time: this.stamp(), action: "delete", path: page.path, detail: page.title, source }]);
      return true;
    });
  }

  /** Deletes every page and the change log, then logs the wipe itself. Settings stay. */
  wipe(): Promise<void> {
    return this.exclusive(async () => {
      await this.folder.removeKind(PAGES);
      await this.folder.removeKind(CHANGES);
      await this.folder.removeKind(SNAPSHOTS);
      this.pages.clear();
      this.index.clear();
      this.vectors.clear();
      await this.log([{ time: this.stamp(), action: "wipe", path: "", detail: "All memory was deleted", source: "user" }]);
    });
  }

  private async write(page: Page): Promise<void> {
    await this.snapshot(page.id, page.path);
    await this.folder.put(PAGES, page.id, renderPage(page));
    this.remember(page);
  }

  /** Pages changed in the current operation and their snapshots, attached to its log entries. */
  private pendingSnapshots = new Map<string, string>();

  /** Keeps the page as it is now (or that it didn't exist) before the first change in an operation. */
  private async snapshot(pageId: string, path: string): Promise<void> {
    if (this.pendingSnapshots.has(path)) return;
    const current = this.pages.get(pageId);
    const before = current ? renderPage(current) : null;
    if (before && before.length > MAX_SNAPSHOT) return;
    const id = randomBytes(8).toString("hex");
    const snap: Snapshot = { pageId, path, before };
    await this.folder.put(SNAPSHOTS, id, JSON.stringify(snap));
    this.pendingSnapshots.set(path, id);
  }

  /**
   * Undoes one change: the page goes back to how it was before it, or away if the change created
   * it. The undo is itself logged, so it can be undone too.
   */
  revert(snapshotId: string): Promise<Page | null> {
    return this.exclusive(async () => {
      if (!/^[0-9a-f]{16}$/.test(snapshotId)) throw new Error("no such change");
      const text = await this.folder.get(SNAPSHOTS, snapshotId).catch(() => null);
      if (!text) throw new Error("this change can no longer be undone");
      const snap = JSON.parse(text) as Snapshot;
      const current = this.pages.get(snap.pageId);
      if (snap.before === null) {
        if (current) {
          await this.snapshot(current.id, current.path);
          await this.folder.remove(PAGES, current.id);
          this.pages.delete(current.id);
          this.index.remove(current.id);
          this.vectors.delete(current.id);
        }
        await this.log([{ time: this.stamp(), action: "revert", path: snap.path, detail: "Undid a change: the page is gone again", source: "user" }]);
        return null;
      }
      const restored = parsePage(snap.before);
      const other = this.get(restored.path);
      if (other && other.id !== snap.pageId) throw new Error(`another page now lives at ${restored.path}`);
      const page: Page = { ...restored, id: snap.pageId, updated: this.stamp() };
      await this.write(page);
      await this.log([{ time: this.stamp(), action: "revert", path: page.path, detail: "Undid a change", source: "user" }]);
      return page;
    });
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
    // Each change points at the snapshot taken before its page first changed in this operation.
    const pending = this.pendingSnapshots;
    this.pendingSnapshots = new Map();
    changes = changes.map((c) => (pending.has(c.path) && !c.snapshot ? { ...c, snapshot: pending.get(c.path)! } : c));
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
