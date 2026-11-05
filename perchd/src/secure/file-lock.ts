/**
 * Runs read-modify-write steps on one settings file one at a time: queued within this process,
 * and guarded across processes (perchd and the CLI) by a lock folder next to the file.
 */

import { mkdir, rmdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** A lock older than this was left by a process that died; it is taken over. */
const STALE_MS = 15_000;
const WAIT_MS = 10_000;

let queues: ReadonlyMap<string, Promise<unknown>> = new Map();

async function acquire(lock: string): Promise<void> {
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
    if (age > STALE_MS) await rmdir(lock).catch(() => undefined);
    else if (Date.now() > deadline) throw new Error("Perch's settings are being changed by another process; try again.");
    else await Bun.sleep(15);
  }
}

export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const previous = queues.get(path) ?? Promise.resolve();
  const run = previous.then(async () => {
    await acquire(lock);
    try {
      return await fn();
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  });
  queues = new Map([...queues, [path, run.catch(() => undefined)]]);
  return run;
}
