/**
 * Read a source browser's SQLite file from a private copy. The source browser may hold a lock
 * or be mid-write, so the file and its WAL are copied to a fresh 0700 temp dir first, and the
 * copy is removed when the callback returns.
 */

import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ImportError } from "./types";

export async function withSqliteCopy<T>(path: string, read: (db: Database) => T | Promise<T>): Promise<T> {
  if (!existsSync(path)) throw new ImportError(`${basename(path)} was not found.`, "not-found");
  const dir = mkdtempSync(join(tmpdir(), "perch-import-"));
  chmodSync(dir, 0o700);
  try {
    const copy = join(dir, "db.sqlite");
    copyOrExplain(path, copy);
    for (const suffix of ["-wal", "-journal"]) {
      if (existsSync(path + suffix)) copyOrExplain(path + suffix, copy + suffix);
    }
    const db = new Database(copy);
    try {
      return await read(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function copyOrExplain(from: string, to: string): void {
  try {
    copyFileSync(from, to);
  } catch (error) {
    throw permissionError(error, from) ?? error;
  }
}

/** EPERM/EACCES under ~/Library usually means macOS privacy protection, not file modes. */
export function permissionError(error: unknown, path: string): ImportError | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code !== "EPERM" && code !== "EACCES") return undefined;
  return new ImportError(
    `macOS blocked reading ${basename(path)}. Open System Settings > Privacy & Security > Full Disk Access, turn on Perch, then try again.`,
    "full-disk-access",
  );
}

export function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}

export function columns(db: Database, table: string): ReadonlySet<string> {
  return new Set((db.query(`PRAGMA table_info("${table.replace(/"/g, "")}")`).all() as { name: string }[]).map((c) => c.name));
}
