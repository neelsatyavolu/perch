/**
 * The import bundle: imported data for the browser to apply (open tabs, search
 * engines, addresses, extensions, passwords, cookies, Aside memory/skills/chats, and bookmarks
 * and history when Perch was open). It holds secrets, so it is sealed with AES-256-GCM under a
 * fresh random key kept in the Keychain ("Perch Import", account = bundle id), never on disk.
 *
 * File: "PRCHIMP1" | 12-byte IV | 16-byte tag | ciphertext of the JSON. The bundle id is the
 * additional authenticated data, so a file cannot be swapped for another bundle's.
 * The browser opens it, applies each part, then calls `discardBundle`.
 *
 * One pending bundle per source: importing the same browser profile again replaces the parts it
 * re-imports and keeps the rest, so repeated imports never pile up copies of the same secrets.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Keychain } from "./keychain";
import { ImportError, type ImportData } from "./types";
import { writeAtomically } from "./write/atomic";

export const BUNDLE_SERVICE = "Perch Import";
const MAGIC = Buffer.from("PRCHIMP1");
const SUFFIX = ".perchimport";

export type Bundle = {
  readonly version: 1;
  readonly id: string;
  readonly created: number;
  readonly source: { readonly browser: string; readonly profile: string };
  readonly data: ImportData;
};

export function bundleDir(userDataDir: string): string {
  return join(userDataDir, "Perch Import");
}

export async function sealBundle(userDataDir: string, keychain: Keychain, source: Bundle["source"], data: ImportData, now = Date.now()): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const key = randomBytes(32);
  await keychain.set(BUNDLE_SERVICE, id, key.toString("base64"));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  const plain = Buffer.from(JSON.stringify({ version: 1, id, created: now, source, data } satisfies Bundle));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  const dir = bundleDir(userDataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}${SUFFIX}`);
  writeAtomically(path, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), sealed]).toString("base64"));
  return { id, path };
}

export function pendingBundles(userDataDir: string): string[] {
  try {
    return readdirSync(bundleDir(userDataDir))
      .filter((n) => n.endsWith(SUFFIX) && /^[0-9a-f-]{36}\.perchimport$/.test(n))
      .map((n) => n.slice(0, -SUFFIX.length));
  } catch {
    return [];
  }
}

export async function openBundle(userDataDir: string, keychain: Keychain, id: string): Promise<Bundle> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ImportError("Not an import bundle id.", "invalid");
  let raw: Buffer;
  try {
    raw = Buffer.from(readFileSync(join(bundleDir(userDataDir), `${id}${SUFFIX}`), "utf8"), "base64");
  } catch {
    throw new ImportError("This import bundle no longer exists.", "not-found");
  }
  const keyText = await keychain.find(BUNDLE_SERVICE, id);
  if (!keyText) throw new ImportError("The key for this import is missing from the Keychain, so it cannot be opened.", "not-found");
  if (raw.length < 36 || !raw.subarray(0, 8).equals(MAGIC)) throw new ImportError("This import bundle is damaged.", "unreadable");
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyText, "base64"), raw.subarray(8, 20));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(raw.subarray(20, 36));
    const plain = Buffer.concat([decipher.update(raw.subarray(36)), decipher.final()]);
    const bundle = JSON.parse(plain.toString("utf8")) as Bundle;
    if (bundle.version !== 1 || bundle.id !== id) throw new Error("mismatch");
    return bundle;
  } catch {
    throw new ImportError("This import bundle is damaged or was changed.", "unreadable");
  }
}

export async function discardBundle(userDataDir: string, keychain: Keychain, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ImportError("Not an import bundle id.", "invalid");
  rmSync(join(bundleDir(userDataDir), `${id}${SUFFIX}`), { force: true });
  await keychain.remove(BUNDLE_SERVICE, id);
}

const sameSource = (a: Bundle["source"], b: Bundle["source"]) => a.browser === b.browser && a.profile === b.profile;

/**
 * Takes data types out of the source's pending bundles once they are in Perch: what is left is
 * sealed again, and a bundle with nothing left is discarded with its key.
 */
export async function dropFromBundles(userDataDir: string, keychain: Keychain, source: Bundle["source"], types: readonly (keyof ImportData)[]): Promise<void> {
  for (const id of pendingBundles(userDataDir)) {
    try {
      const bundle = await openBundle(userDataDir, keychain, id);
      if (!sameSource(bundle.source, source) || !types.some((t) => t in bundle.data)) continue;
      const left = Object.fromEntries(Object.entries(bundle.data).filter(([type]) => !(types as readonly string[]).includes(type))) as ImportData;
      if (Object.keys(left).length) await sealBundle(userDataDir, keychain, bundle.source, left, bundle.created);
      await discardBundle(userDataDir, keychain, id);
    } catch {
      // A damaged bundle, or one whose key is gone, is left alone; it cannot be opened to trim.
    }
  }
}

/** Seal `data` together with what an older pending bundle from the same source holds, then discard that bundle and its key. */
export async function sealReplacingBundle(userDataDir: string, keychain: Keychain, source: Bundle["source"], data: ImportData, now = Date.now()): Promise<{ id: string; path: string }> {
  const older: Bundle[] = [];
  for (const id of pendingBundles(userDataDir)) {
    try {
      const bundle = await openBundle(userDataDir, keychain, id);
      if (sameSource(bundle.source, source)) older.push(bundle);
    } catch {
      // A damaged bundle, or one whose key is gone, is left alone; it cannot be merged.
    }
  }
  const byAge = [...older].sort((a, b) => a.created - b.created);
  const merged = Object.assign({}, ...byAge.map((b) => b.data), data) as ImportData;
  const sealed = await sealBundle(userDataDir, keychain, source, merged, now);
  for (const bundle of older) await discardBundle(userDataDir, keychain, bundle.id);
  return sealed;
}
