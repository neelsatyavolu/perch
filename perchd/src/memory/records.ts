/**
 * A folder of encrypted records, one file per record: `<dir>/<kind>/<id>.prc`. File names are
 * random ids, so a copy of the folder reveals nothing. Writes go to a temp file and are renamed.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { decrypt, encrypt, loadDataKey } from "./crypto";
import type { KeyStore } from "./keychain";

const KIND = /^[a-z]{1,32}$/;
const ID = /^[a-f0-9]{16,64}$/;
const EXT = ".prc";

function check(kind: string, id?: string): void {
  if (!KIND.test(kind)) throw new Error(`bad record kind "${kind.slice(0, 40)}"`);
  if (id !== undefined && !ID.test(id)) throw new Error(`bad record id "${id.slice(0, 40)}"`);
}

/** Whether a folder holds any encrypted records. */
export async function hasRecords(dir: string): Promise<boolean> {
  const kinds = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const k of kinds) {
    if (!k.isDirectory()) continue;
    const files = await readdir(join(dir, k.name)).catch(() => [] as string[]);
    if (files.some((f) => f.endsWith(EXT))) return true;
  }
  return false;
}

export class RecordFolder {
  private constructor(
    readonly dir: string,
    private readonly key: Uint8Array,
  ) {}

  /**
   * Opens a folder with the profile's data key. A new key is made only when no records exist;
   * callers that share one key across folders pass `createKey` after checking all of them.
   */
  static async open(dir: string, keys: KeyStore, profile: string, opts: { createKey?: boolean } = {}): Promise<RecordFolder> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const key = await loadDataKey(keys, profile, { create: opts.createKey ?? !(await hasRecords(dir)) });
    return new RecordFolder(dir, key);
  }

  private file(kind: string, id: string): string {
    return join(this.dir, kind, `${id}${EXT}`);
  }

  async put(kind: string, id: string, text: string): Promise<void> {
    check(kind, id);
    const folder = join(this.dir, kind);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temp = join(folder, `.${id}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temp, encrypt(this.key, text, `${kind}/${id}`), { mode: 0o600 });
    await rename(temp, this.file(kind, id));
  }

  async get(kind: string, id: string): Promise<string | null> {
    check(kind, id);
    const blob = await readFile(this.file(kind, id)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    return blob ? decrypt(this.key, blob, `${kind}/${id}`).toString("utf8") : null;
  }

  async ids(kind: string): Promise<string[]> {
    check(kind);
    const files = await readdir(join(this.dir, kind)).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(EXT)).map((f) => f.slice(0, -EXT.length)).filter((id) => ID.test(id)).sort();
  }

  /** Every readable record of a kind; ones that fail to decrypt are listed in `damaged`. */
  async all(kind: string): Promise<{ records: { id: string; text: string }[]; damaged: string[] }> {
    const records: { id: string; text: string }[] = [];
    const damaged: string[] = [];
    for (const id of await this.ids(kind)) {
      try {
        const text = await this.get(kind, id);
        if (text !== null) records.push({ id, text });
      } catch {
        damaged.push(id);
      }
    }
    return { records, damaged };
  }

  async remove(kind: string, id: string): Promise<void> {
    check(kind, id);
    await rm(this.file(kind, id), { force: true });
  }

  async removeKind(kind: string): Promise<void> {
    check(kind);
    await rm(join(this.dir, kind), { recursive: true, force: true });
  }
}
