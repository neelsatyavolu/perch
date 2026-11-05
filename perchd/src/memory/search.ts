/**
 * Local memory search (spec 8): SQLite FTS5 through bun:sqlite. The index lives in RAM and is
 * rebuilt from the decrypted pages when the store opens, so no plaintext index touches the disk.
 * An optional Embedder (a small local model) can add vector ranks; results are fused by rank.
 */

import { Database } from "bun:sqlite";
import type { Page } from "./page";
import type { Category } from "./sanitize";

export type SearchHit = { id: string; path: string; title: string; category: Category; snippet: string; score: number };
export type SearchOptions = { limit?: number; categories?: readonly Category[] };

/** A local text embedding model. None ships yet; see the plan's deferral note. */
export interface Embedder {
  readonly id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const STOP = new Set(
  "a an and or not near the of to in on at for with is are was were be been what where when who whom how why does do did my me i you your it its this that these those from by about as s".split(" "),
);
const TITLE_WEIGHT = 4;
const BODY_WEIGHT = 1;
const HISTORY_WEIGHT = 0.3;

/** Words from free text as an FTS5 query: each quoted, prefix-matched and ORed. Null when nothing is left. */
export function ftsQuery(text: string): string | null {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
  const unique = [...new Set(words)].slice(0, 16);
  return unique.length ? unique.map((w) => `"${w}"*`).join(" OR ") : null;
}

/** Reciprocal rank fusion of several ranked id lists. */
export function fuse(lists: readonly (readonly string[])[], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function pageText(page: Page): { body: string; history: string } {
  return { body: page.current.map((f) => f.text).join("\n"), history: page.history.map((f) => f.text).join("\n") };
}

export class MemoryIndex {
  private readonly db = new Database(":memory:");

  constructor() {
    this.db.run(
      "CREATE VIRTUAL TABLE pages USING fts5(id UNINDEXED, path UNINDEXED, category UNINDEXED, title, body, history, tokenize = 'porter unicode61 remove_diacritics 2')",
    );
  }

  upsert(page: Page): void {
    const { body, history } = pageText(page);
    this.db.run("DELETE FROM pages WHERE id = ?", [page.id]);
    this.db.run("INSERT INTO pages (id, path, category, title, body, history) VALUES (?, ?, ?, ?, ?, ?)", [page.id, page.path, page.category, `${page.title} ${page.path}`, body, history]);
  }

  remove(id: string): void {
    this.db.run("DELETE FROM pages WHERE id = ?", [id]);
  }

  clear(): void {
    this.db.run("DELETE FROM pages");
  }

  search(text: string, opts: SearchOptions = {}): SearchHit[] {
    const query = ftsQuery(text);
    if (!query) return [];
    const limit = Math.max(1, Math.min(50, opts.limit ?? 8));
    const cats = opts.categories?.length ? opts.categories : null;
    const filter = cats ? ` AND category IN (${cats.map(() => "?").join(",")})` : "";
    const rows = this.db
      .query(
        `SELECT id, path, category, title, snippet(pages, 4, '', '', '…', 16) AS snippet, bm25(pages, 0, 0, 0, ${TITLE_WEIGHT}, ${BODY_WEIGHT}, ${HISTORY_WEIGHT}) AS rank
         FROM pages WHERE pages MATCH ?${filter} ORDER BY rank LIMIT ?`,
      )
      .all(query, ...(cats ?? []), limit) as { id: string; path: string; category: Category; title: string; snippet: string; rank: number }[];
    return rows.map((r) => ({ id: r.id, path: r.path, category: r.category, title: r.title.slice(0, r.title.length - r.path.length - 1), snippet: r.snippet, score: -r.rank }));
  }

  close(): void {
    this.db.close();
  }
}
