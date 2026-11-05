/**
 * Chromium's macOS OSCrypt: a password from the "<Browser> Safe Storage" Keychain item,
 * stretched with PBKDF2-HMAC-SHA1 (salt "saltysalt", 1003 rounds) into an AES-128 key.
 * Values are "v10" + AES-128-CBC(key, iv = 16 spaces, PKCS#7).
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import type { KeychainLabel } from "../catalog";
import type { Keychain } from "../keychain";
import { ImportError } from "../types";

const SALT = "saltysalt";
const ROUNDS = 1003;
const IV = Buffer.alloc(16, 0x20);
const PREFIX = Buffer.from("v10");

/** An opaque derived key. Never logged or serialised. */
export type SafeStorageKey = { readonly bytes: Buffer };

export function deriveKey(password: string): SafeStorageKey {
  return { bytes: pbkdf2Sync(password, SALT, ROUNDS, 16, "sha1") };
}

/** Ask the Keychain for the first label that exists. Throws when the user denies access or none exists. */
export async function safeStorageKey(keychain: Keychain, labels: readonly KeychainLabel[], browser: string): Promise<SafeStorageKey> {
  for (const label of labels) {
    const password = await keychain.find(label.service, label.account);
    if (password) return deriveKey(password);
  }
  throw new ImportError(`${browser} has no Safe Storage item in the Keychain, so its passwords and cookies cannot be read.`, "not-found");
}

/** Decrypt one stored value. Returns undefined for values this Mac cannot read (another OS, a newer scheme). */
export function decrypt(key: SafeStorageKey, value: Uint8Array | null | undefined): Buffer | undefined {
  if (!value || value.length === 0) return Buffer.alloc(0);
  const buf = Buffer.from(value);
  if (!buf.subarray(0, 3).equals(PREFIX)) return undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key.bytes, IV);
    return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  } catch {
    return undefined;
  }
}

export function encrypt(key: SafeStorageKey, plain: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key.bytes, IV);
  return Buffer.concat([PREFIX, cipher.update(plain), cipher.final()]);
}
