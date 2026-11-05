/**
 * AES-256-GCM for Perch's own files at rest (spec 11.1).
 * Layout: "PRCH" | version (1) | IV (12) | tag (16) | ciphertext. The context string (the file's
 * name) is bound as associated data, so a sealed file cannot be swapped in for another.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("PRCH");
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = MAGIC.length + 1;
export const KEY_BYTES = 32;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new SealError("The encryption key must be 32 bytes.");
}

export function newKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

export function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Uint8Array {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]));
}

export function open(key: Uint8Array, sealed: Uint8Array, context: string): Uint8Array {
  checkKey(key);
  const data = Buffer.from(sealed);
  if (data.length < HEADER + IV_BYTES + TAG_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new SealError("This is not a Perch encrypted file.");
  }
  if (data[MAGIC.length] !== VERSION) throw new SealError("This file was written by a newer Perch.");
  const iv = data.subarray(HEADER, HEADER + IV_BYTES);
  const tag = data.subarray(HEADER + IV_BYTES, HEADER + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(data.subarray(HEADER + IV_BYTES + TAG_BYTES)), decipher.final()]));
  } catch {
    throw new SealError("The file could not be decrypted: wrong key or changed contents.");
  }
}
