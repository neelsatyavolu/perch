/**
 * Encryption at rest for Perch's own data (spec 11.1): AES-256-GCM with a per-profile key kept in
 * the Keychain. Each record is sealed on its own with its id as additional data, so a record
 * copied to another id, or changed by one byte, does not open.
 *
 * Blob layout: [version 1][12-byte IV][ciphertext and 16-byte tag].
 */

import type { Keychain } from "./keychain";

const SERVICE = "Perch Data Key";
const VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export class Vault {
  private constructor(private readonly key: CryptoKey) {}

  /** Reads the profile's key from the Keychain, creating it the first time. */
  static async open(keychain: Keychain, profile: string): Promise<Vault> {
    let stored = await keychain.read(SERVICE, profile);
    if (stored === null) {
      stored = toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
      await keychain.write(SERVICE, profile, stored);
    }
    const raw = Buffer.from(stored, "base64url");
    if (raw.length !== KEY_BYTES) throw new Error(`The Keychain item "${SERVICE}" for ${profile} is not a Perch key. Remove it in Keychain Access to start over.`);
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    raw.fill(0);
    return new Vault(key);
  }

  async seal(id: string, data: Uint8Array | string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plain = typeof data === "string" ? encoder.encode(data) : Uint8Array.from(data);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(id) }, this.key, plain));
    const out = new Uint8Array(1 + IV_BYTES + sealed.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(sealed, 1 + IV_BYTES);
    return out;
  }

  async open(id: string, blob: Uint8Array): Promise<Uint8Array> {
    if (blob.length < 1 + IV_BYTES + 16 || blob[0] !== VERSION) throw new Error(`Record ${id} could not be decrypted: unknown format`);
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: Uint8Array.from(blob.subarray(1, 1 + IV_BYTES)), additionalData: encoder.encode(id) },
        this.key,
        Uint8Array.from(blob.subarray(1 + IV_BYTES)),
      );
      return new Uint8Array(plain);
    } catch {
      throw new Error(`Record ${id} could not be decrypted: it was changed, moved, or sealed with another key`);
    }
  }

  sealJson(id: string, value: unknown): Promise<Uint8Array> {
    return this.seal(id, JSON.stringify(value));
  }

  async openJson<T>(id: string, blob: Uint8Array): Promise<T> {
    return JSON.parse(decoder.decode(await this.open(id, blob))) as T;
  }
}
