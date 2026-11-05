/**
 * AES-256-GCM for Perch's own data (spec 11.1). Each record is `PRC1 | iv(12) | tag(16) | ciphertext`
 * and is bound to its own id through the associated data, so records cannot be swapped.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyStore } from "./keychain";

export const KEY_BYTES = 32;
const MAGIC = Buffer.from("PRC1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = MAGIC.length + IV_BYTES + TAG_BYTES;

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new Error(`the data key must be ${KEY_BYTES} bytes`);
}

export function encrypt(key: Uint8Array, plaintext: string | Uint8Array, aad: string): Buffer {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(key: Uint8Array, blob: Uint8Array, aad: string): Buffer {
  checkKey(key);
  const data = Buffer.from(blob);
  if (data.length < HEADER || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a Perch record");
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = data.subarray(MAGIC.length + IV_BYTES, HEADER);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(HEADER)), decipher.final()]);
  } catch {
    throw new Error("the record could not be decrypted: wrong key, or the file was changed");
  }
}

/**
 * The profile's data key from the Keychain. A new key is made only when `create` is true, which
 * callers set when no encrypted data exists yet; otherwise a lost key would orphan the data.
 */
export async function loadDataKey(store: KeyStore, profile: string, opts: { create: boolean }): Promise<Uint8Array> {
  const account = `data-key:${profile}`;
  const saved = await store.get(account);
  if (saved !== null) {
    const key = Buffer.from(saved, "base64");
    if (key.length !== KEY_BYTES) throw new Error("Perch's data key in the Keychain is damaged");
    return new Uint8Array(key);
  }
  if (!opts.create) {
    throw new Error("Perch's data key is missing from the Keychain, so saved memory cannot be read. Restore it from your recovery key or export file.");
  }
  const key = randomBytes(KEY_BYTES);
  await store.set(account, key.toString("base64"));
  return new Uint8Array(key);
}
