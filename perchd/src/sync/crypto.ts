/**
 * Item encryption for sync. The 32-byte sync key never leaves the device's Keychain unwrapped.
 * Two keys are derived from it with HKDF: one encrypts items (AES-256-GCM), one turns real ids
 * (a bookmark's id, a history URL) into opaque HMAC item ids so the server never sees them.
 */
import { concat, fromUtf8, randomBytes, toBase64Url, fromBase64Url, utf8, type Bytes } from "./encoding";

export type SyncKeys = { encrypt: CryptoKey; ids: CryptoKey; version: number };

const IV_BYTES = 12;
const FORMAT = 1;

export const newSyncKey = (): Bytes => randomBytes(32);

export async function deriveSyncKeys(raw: Uint8Array, version: number): Promise<SyncKeys> {
  if (raw.length !== 32) throw new Error("A sync key is 32 bytes");
  const base = await crypto.subtle.importKey("raw", new Uint8Array(raw), "HKDF", false, ["deriveKey"]);
  const derive = (info: string, algorithm: AesKeyGenParams | HmacImportParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(info) }, base, algorithm, false, usages);
  return {
    encrypt: await derive("perch-sync-v1 item-encryption", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    ids: await derive("perch-sync-v1 item-ids", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
    version,
  };
}

/** The opaque id the server sees for a real id in a collection. */
export async function itemId(keys: SyncKeys, collection: string, naturalId: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.ids, utf8(`${collection}\n${naturalId}`)));
  return toBase64Url(mac.slice(0, 24));
}

/** Additional data: a ciphertext only opens in the slot it was written for. */
const aad = (collection: string, id: string, version: number, keyVersion: number) =>
  utf8(`perch-sync-v1|${collection}|${id}|${version}|${keyVersion}`);

export async function encryptItem(keys: SyncKeys, collection: string, id: string, version: number, plaintext: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(collection, id, version, keys.version) },
    keys.encrypt,
    utf8(plaintext),
  );
  return toBase64Url(concat(new Uint8Array([FORMAT]), iv, new Uint8Array(sealed)));
}

/** Throws if the ciphertext was changed, moved to another item, collection or version, or made with another key. */
export async function decryptItem(keys: SyncKeys, collection: string, id: string, version: number, ciphertext: string | Bytes): Promise<string> {
  const bytes = typeof ciphertext === "string" ? fromBase64Url(ciphertext) : ciphertext;
  if (bytes[0] !== FORMAT || bytes.length < 1 + IV_BYTES + 16) throw new Error("Unknown sync item format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(1, 1 + IV_BYTES), additionalData: aad(collection, id, version, keys.version) },
    keys.encrypt,
    bytes.slice(1 + IV_BYTES),
  );
  return fromUtf8(new Uint8Array(plain));
}
