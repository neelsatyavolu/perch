/**
 * Debug transcripts on disk (agent/debug-transcript.ts): one file per chat, one line per flush. Each line
 * is the flushed events as JSON, gzip-compressed and then sealed with the profile's key (vault.ts),
 * so the file is small and unreadable without Perch. Files older than 30 days go first, then the
 * oldest until all of them fit in 200 MB.
 */

import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Transcript, TranscriptEvent, TranscriptRecord } from "../agent/debug-transcript";
import type { Vault } from "./vault";

export type TranscriptLimits = { maxAgeMs?: number; maxBytes?: number };
/** `isLive` says whether a chat still exists: a deleted chat's transcript goes at the next prune. */
export type TranscriptOptions = TranscriptLimits & { isLive?: (chatId: string) => boolean; log?: (message: string) => void };

const DAY_MS = 86_400_000;
const DEFAULTS = { maxAgeMs: 30 * DAY_MS, maxBytes: 200 * 1024 * 1024 };
const EXT = ".ptr";
const ID = /^[\w.:-]{1,128}$/;
/** Events that end a stretch of work: written out then, so a crash loses little. */
const FLUSH_ON = new Set<TranscriptEvent["kind"]>(["turn", "approval", "end"]);
/** Pruning runs at most this often while writing. */
const PRUNE_EVERY_MS = 60 * 60_000;

/** A run's transcript: records go into a buffer that is written at each turn and at the end. */
export type TranscriptWriter = Transcript & { flush(): Promise<void> };

export class TranscriptStore {
  /** Writes per chat, one after another, so lines never interleave. */
  private tails = new Map<string, Promise<void>>();
  private prunedAt = 0;

  private constructor(
    private readonly dir: string,
    private readonly vault: Vault,
    private readonly limits: Required<TranscriptLimits>,
    private readonly isLive: (chatId: string) => boolean,
    private readonly log: (message: string) => void,
  ) {}

  static async open(dir: string, vault: Vault, options: TranscriptOptions = {}): Promise<TranscriptStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { isLive = () => true, log = () => {}, ...limits } = options;
    return new TranscriptStore(dir, vault, { ...DEFAULTS, ...limits }, isLive, log);
  }

  writer(chatId: string): TranscriptWriter {
    const file = this.fileFor(chatId);
    let buffer: TranscriptRecord[] = [];
    const flush = (): Promise<void> => {
      if (!buffer.length) return this.tails.get(chatId) ?? Promise.resolve();
      const records = buffer;
      buffer = [];
      return this.enqueue(chatId, () => this.append(chatId, file, records));
    };
    return {
      record: (event) => {
        buffer = [...buffer, { ...event, time: new Date().toISOString() }];
        if (FLUSH_ON.has(event.kind)) void flush();
      },
      flush,
    };
  }

  /** Every event recorded for a chat, oldest first; lines that do not open are skipped. */
  async read(chatId: string): Promise<TranscriptRecord[]> {
    const file = this.fileFor(chatId);
    await this.tails.get(chatId);
    const text = await readFile(file, "utf8").catch(() => "");
    const lines = text.split("\n").filter(Boolean);
    const batches = await Promise.all(lines.map((line) => this.openLine(chatId, line)));
    return batches.flat();
  }

  async remove(chatId: string): Promise<void> {
    const file = this.fileFor(chatId);
    await this.tails.get(chatId);
    await rm(file, { force: true });
  }

  /** Drops transcripts past their age or of deleted chats, then the oldest until the rest fit the size cap. */
  async prune(now = Date.now()): Promise<void> {
    this.prunedAt = now;
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith(EXT));
    const files = await Promise.all(names.map(async (name) => ({ name, ...(await stat(join(this.dir, name)).catch(() => null)) })));
    const known = files.filter((f): f is typeof f & { size: number; mtimeMs: number } => typeof f.size === "number");
    const fresh = known.filter((f) => now - f.mtimeMs <= this.limits.maxAgeMs && this.isLive(f.name.slice(0, -EXT.length)));
    const stale = known.filter((f) => !fresh.includes(f));
    const newestFirst = [...fresh].sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = 0;
    const over = newestFirst.filter((f) => (total += f.size) > this.limits.maxBytes);
    await Promise.all([...stale, ...over].map((f) => rm(join(this.dir, f.name), { force: true })));
  }

  private fileFor(chatId: string): string {
    if (!ID.test(chatId)) throw new Error(`Not a chat id: ${chatId}`);
    return join(this.dir, `${chatId}${EXT}`);
  }

  private enqueue(chatId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(chatId) ?? Promise.resolve()).then(work).catch((error) => this.log(`transcript ${chatId}: ${String(error)}`));
    this.tails.set(chatId, next);
    void next.then(() => {
      if (this.tails.get(chatId) === next) this.tails.delete(chatId);
    });
    return next;
  }

  private async append(chatId: string, file: string, records: TranscriptRecord[]): Promise<void> {
    const sealed = await this.vault.seal(`transcript:${chatId}`, gzipSync(JSON.stringify(records)));
    await appendFile(file, `${Buffer.from(sealed).toString("base64url")}\n`, { mode: 0o600 });
    if (Date.now() - this.prunedAt > PRUNE_EVERY_MS) await this.prune();
  }

  private async openLine(chatId: string, line: string): Promise<TranscriptRecord[]> {
    try {
      const plain = await this.vault.open(`transcript:${chatId}`, Buffer.from(line, "base64url"));
      return JSON.parse(gunzipSync(plain).toString("utf8")) as TranscriptRecord[];
    } catch {
      return [];
    }
  }
}
