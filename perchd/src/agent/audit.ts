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

/** Where else each entry goes: the company's copy. It never throws; it records its own errors. */
export type AuditSink = { write(entry: AuditEntry): void };

export type AuditLogOptions = {
  /** Log files from older versions, merged into this one on first use. */
  legacy?: readonly string[];
  mirror?: AuditSink;
};

const MAX_READ = 500;

function parse(line: string): AuditEntry | null {
  try {
    const e = JSON.parse(line) as AuditEntry;
    return typeof e?.time === "string" && typeof e.action === "string" ? e : null;
  } catch {
    return null;
  }
}

const byTime = (a: AuditEntry, b: AuditEntry) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

export class AuditLog {
  private ready: Promise<void> | null = null;

  constructor(readonly path: string, private readonly opts: AuditLogOptions = {}) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.open();
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
    this.opts.mirror?.write(entry);
  }

  /** Every entry, oldest first. */
  async entries(): Promise<AuditEntry[]> {
    await this.open();
    const text = await readFile(this.path, "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).map(parse).filter((e): e is AuditEntry => e !== null);
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
      await mergeLegacy(this.path, this.opts.legacy ?? []);
    })();
    return this.ready;
  }
}

/** Merges older logs into `path`, each entry once and in time order, then removes them. */
export async function mergeLegacy(path: string, legacy: readonly string[]): Promise<number> {
  const others = legacy.filter((f) => f !== path);
  const texts = await Promise.all(others.map((f) => readFile(f, "utf8").catch(() => null)));
  if (texts.every((t) => t === null)) return 0;
  const current = await readFile(path, "utf8").catch(() => "");
  const lines = [...new Set([current, ...texts].flatMap((t) => (t ?? "").split("\n").filter(Boolean)))];
  const entries = lines.map((line) => ({ line, entry: parse(line) })).filter((x): x is { line: string; entry: AuditEntry } => x.entry !== null);
  entries.sort((a, b) => byTime(a.entry, b.entry));
  const tmp = `${path}.merge-${process.pid}`;
  await writeFile(tmp, entries.map((x) => `${x.line}\n`).join(""), { mode: 0o600 });
  await rename(tmp, path);
  await Promise.all(others.map((f, i) => (texts[i] === null ? undefined : rm(f, { force: true }))));
  return entries.length;
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
