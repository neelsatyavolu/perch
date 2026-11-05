/**
 * Changing another program's config file safely: read, change in memory, back up the original,
 * write a temporary file with the same mode, and rename it into place. If the file changed while
 * we worked (the program wrote it), nothing is written and the user is told to try again.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Action = "created" | "updated" | "unchanged" | "removed" | "skipped";
export type Change = { file: string; action: Action; backup?: string; note?: string };

export function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

/**
 * Writes `next` over `file` if it differs from `before` (what was read). Backs up an existing
 * file first. New files get `newMode`.
 */
export function writeSafely(file: string, before: string | null, next: string, opts: { now: Date; newMode: number }): Change {
  if (before === next) return { file, action: "unchanged" };
  const current = readText(file);
  if (current !== before) throw new Error(`${file} changed while Perch was updating it; run the command again`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const mode = before === null ? opts.newMode : statSync(file).mode & 0o777;
  let backup: string | undefined;
  if (before !== null) {
    const base = `${file}.perch-backup-${stamp(opts.now)}`;
    backup = base;
    // Never overwrite an earlier backup.
    for (let n = 2; existsSync(backup); n++) backup = `${base}-${n}`;
    copyFileSync(file, backup);
    chmodSync(backup, mode);
  }
  const tmp = `${file}.perch-tmp-${process.pid}`;
  writeFileSync(tmp, next, { mode });
  chmodSync(tmp, mode);
  if (readText(file) !== before) {
    rmSync(tmp, { force: true });
    throw new Error(`${file} changed while Perch was updating it; run the command again`);
  }
  renameSync(tmp, file);
  return { file, action: before === null ? "created" : "updated", ...(backup ? { backup } : {}) };
}
