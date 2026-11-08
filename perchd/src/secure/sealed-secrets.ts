/**
 * Secret values (API keys, sign-in tokens, data keys) in one encrypted file per store, sealed
 * under the key the browser derives for that store from the profile's Secure Enclave-wrapped root
 * key (plan 3b, task 3). This replaces per-secret Keychain items: no item exists that another
 * program could ask the Keychain for, and the file is useless without the browser's key.
 *
 * The file is sealed.ts's format, labelled `secrets/<store>`, holding
 * {v: 1, items: {name: value}, marks: [...]}. Writes are locked across processes.
 */

import { readSealedJson, writeSealedJson } from "./sealed";
import { withFileLock } from "./file-lock";

type Contents = { v: 1; items: Record<string, string>; marks: string[] };

const NAME = /^[^\0\n\r]{1,256}$/;
const MAX_VALUE = 64 * 1024;
const EMPTY: Contents = { v: 1, items: {}, marks: [] };

function checkName(name: string): void {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("A secret name must be 1 to 256 plain characters.");
}

export class SealedSecrets {
  private readonly label: string;

  constructor(
    readonly path: string,
    private readonly key: Buffer,
    store: string,
  ) {
    if (key.length !== 32) throw new Error("a store key must be 32 bytes");
    this.label = `secrets/${store}`;
  }

  private async read(): Promise<Contents> {
    const c = await readSealedJson<Contents>(this.path, this.key, this.label);
    if (!c) return EMPTY;
    if (c.v !== 1 || typeof c.items !== "object" || !Array.isArray(c.marks)) throw new Error(`${this.path} is not a Perch secrets file`);
    return c;
  }

  private update<T>(change: (c: Contents) => { next: Contents | null; result: T }): Promise<T> {
    return withFileLock(this.path, async () => {
      const { next, result } = change(await this.read());
      if (next) await writeSealedJson(this.path, this.key, this.label, next);
      return result;
    });
  }

  async get(name: string): Promise<string | null> {
    checkName(name);
    const { items } = await this.read();
    return Object.hasOwn(items, name) ? items[name]! : null;
  }

  async names(): Promise<string[]> {
    return Object.keys((await this.read()).items).sort();
  }

  async set(name: string, value: string): Promise<void> {
    checkName(name);
    if (typeof value !== "string") throw new Error("A secret must be text.");
    if (value.length > MAX_VALUE) throw new Error("A secret is limited to 64 KB.");
    return this.update((c) => ({ next: { ...c, items: { ...c.items, [name]: value } }, result: undefined }));
  }

  /** Creates the item only if it does not exist; returns false, changing nothing, if it does. */
  async add(name: string, value: string): Promise<boolean> {
    checkName(name);
    if (value.length > MAX_VALUE) throw new Error("A secret is limited to 64 KB.");
    return this.update((c) => (Object.hasOwn(c.items, name) ? { next: null, result: false } : { next: { ...c, items: { ...c.items, [name]: value } }, result: true }));
  }

  async delete(name: string): Promise<boolean> {
    checkName(name);
    return this.update((c) => {
      if (!Object.hasOwn(c.items, name)) return { next: null, result: false };
      const items = Object.fromEntries(Object.entries(c.items).filter(([k]) => k !== name));
      return { next: { ...c, items }, result: true };
    });
  }

  async marked(mark: string): Promise<boolean> {
    return (await this.read()).marks.includes(mark);
  }

  mark(mark: string): Promise<void> {
    return this.update((c) => (c.marks.includes(mark) ? { next: null, result: undefined } : { next: { ...c, marks: [...c.marks, mark] }, result: undefined }));
  }
}
