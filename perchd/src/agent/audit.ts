/**
 * The audit log: one JSON line per agent action, readable only by the owner (spec 7.4). One file
 * per profile holds every client: the sidebar, routines, the perch command and each MCP client.
 * Logs older versions kept in separate files are merged into it once, by time, and removed.
 * With a mirror (AuditLogPath, spec 12.2) each entry is also appended to the company's file.
 */

import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditEntry = {
  time: string;
  tab: string;
  site: string;
  /** Where navigate and open_tab went. */
  url?: string;
  action: string;
  detail?: string;
  client: string;
  /** true or false when the user was asked; null when no approval was needed. */
  approved: boolean | null;
  result: "ok" | "error" | "blocked" | "declined";
};

/** Whatever takes entries: the log itself, or a wrapper that drops page text (audit-seal.ts). */
export type AuditWriter = { append(entry: AuditEntry): Promise<void> };

/** Encrypts and decrypts one line (audit-seal.ts). `open` throws on a line it cannot read. */
export type AuditSealer = { seal(text: string): Promise<string>; open(sealed: string): Promise<string> };

/** Where else each entry goes: the company's copy. It never throws; it records its own errors. */
export type AuditSink = { write(entry: AuditEntry): void };

export type AuditLogOptions = {
  /** Log files from older versions, merged into this one on first use. */
  legacy?: readonly string[];
  mirror?: AuditSink;
  /** Seals each new line. Plain lines (older versions, other writers) are still read. */
  sealer?: AuditSealer;
};

const MAX_READ = 500;
const SEALED = "enc1:";
/** Retention: the newest 20,000 entries are kept (the company mirror, if any, keeps everything). */
export const MAX_ENTRIES = 20_000;
/** The log is cut back to MAX_ENTRIES once it grows this far past it, not on every append. */
const TRIM_SLACK = 2_000;

/** One line, plain or sealed; null for a line that is not an entry or does not open. */
async function parse(line: string, sealer?: AuditSealer): Promise<AuditEntry | null> {
  try {
    const text = line.startsWith(SEALED) ? (sealer ? await sealer.open(line.slice(SEALED.length)) : "") : line;
    const e = JSON.parse(text) as AuditEntry;
    return typeof e?.time === "string" && typeof e.action === "string" ? e : null;
  } catch {
    return null;
  }
}

const byTime = (a: AuditEntry, b: AuditEntry) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

async function parseAll(lines: readonly string[], sealer?: AuditSealer): Promise<{ line: string; entry: AuditEntry }[]> {
  const parsed = await Promise.all(lines.map(async (line) => ({ line, entry: await parse(line, sealer) })));
  return parsed.filter((x): x is { line: string; entry: AuditEntry } => x.entry !== null);
}

export class AuditLog implements AuditWriter {
  private ready: Promise<void> | null = null;
  /** Lines already opened, so a read decrypts only what was added since the last one. */
  private parsed: ReadonlyMap<string, AuditEntry | null> = new Map();
  /** Lines in the file as last seen, plus this process's appends since. */
  private lines = 0;

  constructor(readonly path: string, private readonly opts: AuditLogOptions = {}) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.open();
    await appendFile(this.path, `${await sealLine(JSON.stringify(entry), this.opts.sealer)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
    this.opts.mirror?.write(entry);
    if (++this.lines > MAX_ENTRIES + TRIM_SLACK) this.lines = await trimLog(this.path);
  }

  /** Every entry, oldest first. */
  async entries(): Promise<AuditEntry[]> {
    await this.open();
    const text = await readFile(this.path, "utf8").catch(() => "");
    const lines = text.split("\n").filter(Boolean);
    const known = this.parsed;
    const parsed = await Promise.all(lines.map(async (line) => [line, known.has(line) ? known.get(line)! : await parse(line, this.opts.sealer)] as const));
    this.parsed = new Map(parsed);
    this.lines = lines.length;
    const entries = parsed.map(([, e]) => e).filter((e): e is AuditEntry => e !== null);
    // A writer in another process (an outside agent's own log) can append out of order.
    return entries.every((e, i) => i === 0 || entries[i - 1]!.time <= e.time) ? entries : [...entries].sort(byTime);
  }

  /** Newest first, `limit` at most, and only entries older than `before` when it is given. */
  async read({ limit, before }: { limit: number; before?: string }): Promise<AuditEntry[]> {
    const all = await this.entries();
    const older = before ? all.filter((e) => e.time < before) : all;
    const n = Math.min(Math.max(limit, 0), MAX_READ);
    return older.slice(older.length - n).reverse();
  }

  /** The whole log as a file's text, JSON lines or CSV. */
  async export(format: "jsonl" | "csv"): Promise<{ text: string; entries: number }> {
    const all = await this.entries();
    return { text: format === "csv" ? toCsv(all) : all.map((e) => `${JSON.stringify(e)}\n`).join(""), entries: all.length };
  }

  private open(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await mergeLegacy(this.path, this.opts.legacy ?? [], this.opts.sealer);
      this.lines = await trimLog(this.path);
    })();
    return this.ready;
  }
}

async function sealLine(plain: string, sealer?: AuditSealer): Promise<string> {
  return sealer ? `${SEALED}${await sealer.seal(plain)}` : plain;
}

/**
 * Merges older logs into `path`, each entry once and in time order, then removes them. With a
 * sealer, the plain lines they bring are sealed as they move in.
 */
export async function mergeLegacy(path: string, legacy: readonly string[], sealer?: AuditSealer): Promise<number> {
  const others = legacy.filter((f) => f !== path);
  const texts = await Promise.all(others.map((f) => readFile(f, "utf8").catch(() => null)));
  if (texts.every((t) => t === null)) return 0;
  const current = await readFile(path, "utf8").catch(() => "");
  const lines = [...new Set([current, ...texts].flatMap((t) => (t ?? "").split("\n").filter(Boolean)))];
  const entries = await parseAll(lines, sealer);
  entries.sort((a, b) => byTime(a.entry, b.entry));
  const out = await Promise.all(entries.map((x) => (x.line.startsWith(SEALED) ? x.line : sealLine(x.line, sealer))));
  const tmp = `${path}.merge-${process.pid}`;
  await writeFile(tmp, out.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  await rename(tmp, path);
  await Promise.all(others.map((f, i) => (texts[i] === null ? undefined : rm(f, { force: true }))));
  return entries.length;
}

/** Keeps the newest MAX_ENTRIES lines when the file has more; returns how many lines it holds. */
async function trimLog(path: string): Promise<number> {
  const lines = (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);
  if (lines.length <= MAX_ENTRIES) return lines.length;
  const kept = lines.slice(lines.length - MAX_ENTRIES);
  const tmp = `${path}.trim-${process.pid}`;
  await writeFile(tmp, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  await rename(tmp, path);
  return kept.length;
}

const CSV_COLUMNS = ["time", "client", "tab", "site", "url", "action", "detail", "approved", "result"] as const;

/** A spreadsheet must not run a cell as a formula: text starting with = + - or @ gets a leading '. */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(entries: readonly AuditEntry[]): string {
  const rows = entries.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(","));
  return `${[CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}
