/**
 * Encrypted files for Perch's own data (spec 11.1): AES-256-GCM with a random 32-byte data key
 * kept in the Keychain. Each file is bound to a label (its purpose) as associated data, so a
 * registry file cannot be swapped in for a skills file.
 *
 * Format: "PS1" | 12-byte IV | 16-byte tag | ciphertext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretStore } from "./keychain";

const MAGIC = Buffer.from("PS1");
const IV = 12;
const TAG = 16;
const DATA_KEY_ACCOUNT = "data-key";

/** The data key, created on first use. */
export async function dataKey(store: SecretStore, account = DATA_KEY_ACCOUNT): Promise<Buffer> {
  const existing = await store.get(account);
  if (existing) {
    const key = Buffer.from(existing, "base64");
    if (key.length !== 32) throw new Error("the stored data key is damaged");
    return key;
  }
  const key = randomBytes(32);
  await store.set(account, key.toString("base64"));
  return key;
}

export function seal(key: Buffer, plaintext: string, label: string): Buffer {
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(label, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function openSealed(key: Buffer, blob: Buffer, label: string): string {
  if (blob.length < MAGIC.length + IV + TAG || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a Perch encrypted file");
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV);
  const tag = blob.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(label, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(MAGIC.length + IV + TAG)), decipher.final()]).toString("utf8");
}

export async function readSealedJson<T>(path: string, key: Buffer, label: string): Promise<T | null> {
  let blob: Buffer;
  try {
    blob = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(openSealed(key, blob, label)) as T;
  } catch {
    throw new Error(`${path} could not be decrypted; it is damaged or was made with another key`);
  }
}

/** Writes atomically (temp file, then rename), owner-only. */
export async function writeSealedJson(path: string, key: Buffer, label: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, seal(key, JSON.stringify(value), label), { mode: 0o600 });
  await rename(tmp, path);
}
