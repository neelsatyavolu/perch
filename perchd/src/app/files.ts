/** Owner-only folders and atomic writes for the encrypted stores. */

import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** Writes through a temporary file and a rename, so a crash never leaves half a record. */
export async function writePrivate(dir: string, name: string, data: Uint8Array): Promise<void> {
  const tmp = join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, join(dir, name));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Runs tasks for one key one after another; different keys run independently. */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
