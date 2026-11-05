/**
 * Dreaming (spec 8): a nightly consolidation pass. A rule pass removes duplicates, moves expired
 * facts to History and applies episodic retention. An optional model pass may merge facts,
 * retire superseded ones and merge two pages of one category, but only by pointing at facts that
 * exist; it can never invent a page or a fact that is not a merge. Every change goes to a dated log.
 */

import type { Model, ToolSpec } from "../models/types";
import { askForTool, message, str } from "./model-call";
import { factKey, newPage, type Fact, type Page } from "./page";
import { cleanText, looksSecret } from "./sanitize";
import type { MemoryStore } from "./store";

export type DreamReport = {
  date: string;
  duplicates: number;
  expired: number;
  episodicRemoved: number;
  merged: number;
  retired: number;
  pagesMerged: number;
  ignored: number;
  /** Pages left alone because they changed while dreaming ran. */
  skipped: string[];
  logPath: string | null;
  error?: string;
};
export type DreamOptions = { store: MemoryStore; model?: Model; now: Date; signal?: AbortSignal };

const HISTORY_CAP = 100;
const PROMPT_BUDGET = 30_000;
const DAY = 86_400_000;

export const CONSOLIDATE_TOOL: ToolSpec = {
  name: "consolidate",
  description: "Tidy the memory pages. Refer to facts by page path and the numbers shown. Leave lists empty when nothing needs changing.",
  parameters: {
    type: "object",
    properties: {
      merge_facts: {
        type: "array",
        items: { type: "object", properties: { path: { type: "string" }, indexes: { type: "array", items: { type: "number" } }, text: { type: "string" } }, required: ["path", "indexes", "text"] },
      },
      retire: { type: "array", items: { type: "object", properties: { path: { type: "string" }, indexes: { type: "array", items: { type: "number" } } }, required: ["path", "indexes"] } },
      merge_pages: { type: "array", items: { type: "object", properties: { from: { type: "string" }, into: { type: "string" } }, required: ["from", "into"] } },
    },
  },
};

/** A page being tidied: `base` is the page's `updated` when read, `into` is set when it merges away. */
type Draft = { page: Page; base: string; notes: string[]; into?: string };

/** Duplicates out, expired facts to History, History capped. Returns the new page and what changed. */
function tidy(page: Page, today: string): { page: Page; duplicates: number; expired: number } {
  const seen = new Set<string>();
  const kept: Fact[] = [];
  const expired: Fact[] = [];
  let duplicates = 0;
  for (const f of page.current) {
    const key = factKey(f.text);
    if (seen.has(key)) duplicates++;
    else if (f.expires && f.expires < today) expired.push(f);
    else kept.push(f);
    seen.add(key);
  }
  const history = [...page.history, ...expired].slice(-HISTORY_CAP);
  return { page: { ...page, current: kept, history }, duplicates, expired: expired.length };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export async function dream(opts: DreamOptions): Promise<DreamReport> {
  const { store } = opts;
  const date = opts.now.toISOString().slice(0, 10);
  const report: DreamReport = { date, duplicates: 0, expired: 0, episodicRemoved: 0, merged: 0, retired: 0, pagesMerged: 0, ignored: 0, skipped: [], logPath: null };
  const log: string[] = [];

  const retention = store.settings().episodicRetentionDays;
  if (retention !== null) {
    const cutoff = new Date(opts.now.getTime() - retention * DAY).toISOString().slice(0, 10);
    for (const p of store.all().filter((p) => p.category === "episodic" && p.path.slice(9, 19) < cutoff)) {
      await store.deletePage(p.id, "dreaming");
      report.episodicRemoved++;
      log.push(`${p.path}: deleted, older than ${retention} days`);
    }
  }

  const drafts = new Map<string, Draft>();
  for (const p of store.all().filter((p) => p.category !== "log")) {
    const t = tidy(p, date);
    const notes = [
      ...(t.duplicates ? [`removed ${plural(t.duplicates, "duplicate")}`] : []),
      ...(t.expired ? [`moved ${plural(t.expired, "expired fact")} to History`] : []),
    ];
    report.duplicates += t.duplicates;
    report.expired += t.expired;
    drafts.set(p.path, { page: t.page, base: p.updated, notes });
  }

  if (opts.model) {
    try {
      await modelPass(opts.model, drafts, report, opts.now.toISOString(), opts.signal);
    } catch (error) {
      report.error = message(error);
    }
  }

  // Pages that stay are written first; a page merged away is deleted only after its destination is saved.
  const changed = [...drafts.entries()].filter(([, d]) => d.notes.length);
  for (const [path, draft] of changed.filter(([, d]) => !d.into)) {
    const saved = await store.replacePage(draft.page, { action: "dream", detail: draft.notes.join("; "), source: "dreaming" }, draft.base);
    if (saved) log.push(...draft.notes.map((n) => `${path}: ${n}`));
    else report.skipped.push(path);
  }
  for (const [path, draft] of changed.filter(([, d]) => d.into)) {
    const deleted = !report.skipped.includes(draft.into!) && (await store.deletePage(draft.page.id, "dreaming", draft.base));
    if (deleted) log.push(...draft.notes.map((n) => `${path}: ${n}`));
    else report.skipped.push(path);
  }

  if (log.length) report.logPath = await writeLog(store, date, opts.now.toISOString(), log);
  return report;
}

async function writeLog(store: MemoryStore, date: string, now: string, lines: string[]): Promise<string> {
  const path = `log/dreaming-${date}.md`;
  const page = store.get(path) ?? newPage(path, `Dreaming, ${date}`, now);
  const facts: Fact[] = lines.map((text) => ({ text, added: now, source: "dreaming" }));
  await store.replacePage({ ...page, current: [...page.current, ...facts] }, { action: "dream", detail: `${plural(lines.length, "change")} logged`, source: "dreaming" });
  return path;
}

function renderForModel(drafts: Map<string, Draft>): string {
  const blocks: string[] = [];
  let size = 0;
  const pages = [...drafts.values()].map((d) => d.page).sort((a, b) => (a.updated < b.updated ? 1 : -1));
  for (const p of pages) {
    const block = `${p.path} (${p.title})\n${p.current.map((f, i) => `  ${i}. ${f.text}`).join("\n")}`;
    if (size + block.length > PROMPT_BUDGET) break;
    blocks.push(block);
    size += block.length;
  }
  return blocks.join("\n\n");
}

function indexes(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const list = [...new Set(value)];
  return list.every((i) => Number.isInteger(i) && i >= 0 && i < length) ? (list as number[]).sort((a, b) => a - b) : null;
}

async function modelPass(model: Model, drafts: Map<string, Draft>, report: DreamReport, now: string, signal?: AbortSignal): Promise<void> {
  const shown = renderForModel(drafts);
  if (!shown) return;
  const system = [
    "You tidy a private memory of facts about the user. Facts are numbered per page.",
    "merge_facts: combine facts on one page that say the same thing into one sentence.",
    "retire: move facts that a newer fact on the same page replaces (an old job, an old address) to History.",
    "merge_pages: two pages of the same kind about the same subject; facts move into the second.",
    "Change only what is clearly redundant or out of date. Never add new information.",
  ].join("\n");
  const answer = await askForTool(model, { system, user: shown, tool: CONSOLIDATE_TOOL }, signal);
  if (!answer.args) return;
  const used = new Map<string, Set<number>>();
  const take = (path: string, list: number[]) => {
    const set = used.get(path) ?? new Set<number>();
    if (list.some((i) => set.has(i))) return false;
    list.forEach((i) => set.add(i));
    used.set(path, set);
    return true;
  };
  const merges: { path: string; list: number[]; text: string }[] = [];
  const retires: { path: string; list: number[] }[] = [];
  for (const raw of arrayOf(answer.args.merge_facts)) {
    const draft = drafts.get(str(raw.path));
    const list = draft && indexes(raw.indexes, draft.page.current.length);
    const text = cleanText(str(raw.text));
    if (!draft || !list || list.length < 2 || !text || looksSecret(text) || !take(draft.page.path, list)) report.ignored++;
    else merges.push({ path: draft.page.path, list, text });
  }
  for (const raw of arrayOf(answer.args.retire)) {
    const draft = drafts.get(str(raw.path));
    const list = draft && indexes(raw.indexes, draft.page.current.length);
    if (!draft || !list || !take(draft.page.path, list)) report.ignored++;
    else retires.push({ path: draft.page.path, list });
  }
  for (const path of new Set([...merges.map((m) => m.path), ...retires.map((r) => r.path)])) {
    applyFactOps(drafts.get(path)!, merges.filter((m) => m.path === path), retires.filter((r) => r.path === path), now, report);
  }
  const destinations = new Set<Draft>();
  for (const raw of arrayOf(answer.args.merge_pages)) {
    const from = drafts.get(str(raw.from));
    const into = drafts.get(str(raw.into));
    // A page merges away once, never into a page that is itself merging away, and never after receiving facts.
    const chained = from && into && (from.into !== undefined || into.into !== undefined || destinations.has(from));
    if (!from || !into || from === into || chained || from.page.category !== into.page.category || from.page.category === "user" || from.page.category === "rules") {
      report.ignored++;
      continue;
    }
    const keys = new Set(into.page.current.map((f) => factKey(f.text)));
    const moved = from.page.current.filter((f) => !keys.has(factKey(f.text)));
    into.page = { ...into.page, current: [...into.page.current, ...moved], history: [...into.page.history, ...from.page.history].slice(-HISTORY_CAP) };
    into.notes.push(`took ${plural(moved.length, "fact")} from ${from.page.path}`);
    from.page = { ...from.page, current: [], history: [] };
    from.notes.push(`merged into ${into.page.path}`);
    from.into = into.page.path;
    destinations.add(into);
    report.pagesMerged++;
  }
}

function applyFactOps(draft: Draft, merges: { list: number[]; text: string }[], retires: { list: number[] }[], now: string, report: DreamReport): void {
  const current = draft.page.current;
  const retiredIdx = new Set(retires.flatMap((r) => r.list));
  const mergedAt = new Map<number, { list: number[]; text: string }>(merges.map((m) => [m.list[0]!, m]));
  const dropped = new Set(merges.flatMap((m) => m.list.slice(1)));
  const next: Fact[] = [];
  current.forEach((f, i) => {
    const merge = mergedAt.get(i);
    if (merge) next.push({ text: merge.text, added: now, source: "dreaming" });
    else if (!dropped.has(i) && !retiredIdx.has(i)) next.push(f);
  });
  const retired = current.filter((_, i) => retiredIdx.has(i));
  draft.page = { ...draft.page, current: next, history: [...draft.page.history, ...retired].slice(-HISTORY_CAP) };
  for (const m of merges) draft.notes.push(`merged ${plural(m.list.length, "fact")} into "${m.text}"`);
  for (const f of retired) draft.notes.push(`moved "${f.text}" to History`);
  report.merged += merges.length;
  report.retired += retired.length;
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object") : [];
}
