/**
 * Device keys and key wrapping. Each device has a P-256 ECDH key pair; the private half lives in
 * the Keychain. The sync key is wrapped for a device with ECIES (an ephemeral ECDH key, HKDF,
 * AES-256-GCM). Recovery is in recovery.ts.
 */
import { fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8, type Bytes } from "./encoding";

export type DeviceKeys = { publicKey: string; privateKey: CryptoKey };

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  return { publicKey: await exportPublicKey(pair.publicKey), privateKey: pair.privateKey };
}

const exportPublicKey = async (key: CryptoKey) => toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer));
export const importPublicKey = (publicKey: string) => crypto.subtle.importKey("raw", fromBase64Url(publicKey), ECDH, true, []);

/** For the Keychain: the private key as a JWK string, and back. */
export async function exportDeviceKeys(keys: DeviceKeys): Promise<string> {
  return JSON.stringify({ publicKey: keys.publicKey, jwk: await crypto.subtle.exportKey("jwk", keys.privateKey) });
}

export async function importDeviceKeys(serialized: string): Promise<DeviceKeys> {
  const { publicKey, jwk } = JSON.parse(serialized) as { publicKey: string; jwk: JsonWebKey };
  return { publicKey, privateKey: await crypto.subtle.importKey("jwk", jwk, ECDH, true, ["deriveBits"]) };
}

/** ECDH then HKDF to an AES-GCM key; `info` separates every use. */
export async function agreeKey(privateKey: CryptoKey, peerPublicKey: string, salt: Uint8Array, info: string): Promise<CryptoKey> {
  // Cast: Workers' type names the field `$public`, the DOM's `public`; both runtimes take `public`.
  const algorithm = { name: "ECDH", public: await importPublicKey(peerPublicKey) } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const bits = await crypto.subtle.deriveBits(algorithm, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: utf8(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

type DeviceWrap = { v: 1; alg: "p256-hkdf-aesgcm"; epk: string; iv: string; ct: string };

export const pack = (value: object) => toBase64Url(utf8(JSON.stringify(value)));
export const unpack = <T>(blob: string): T => JSON.parse(fromUtf8(fromBase64Url(blob))) as T;
const wrapAad = (slot: string, version: number) => utf8(`perch-key-wrap-v1|${slot}|${version}`);

/** A sync key and the version the server knows it by. */
export type VersionedKey = { version: number; raw: Bytes };

const KEY_BYTES = 32;
const ENTRY_BYTES = 4 + KEY_BYTES;
const MAX_KEYS = 64;

/**
 * Every key version a device needs, as one payload to wrap: items written before a rotation stay
 * readable on a device that joins or recovers after it. Each entry is a 4-byte version and the key.
 */
export function encodeKeys(keys: readonly VersionedKey[]): Bytes {
  if (!keys.length || keys.length > MAX_KEYS) throw new Error("A key payload holds 1 to 64 keys");
  const out = new Uint8Array(keys.length * ENTRY_BYTES);
  const view = new DataView(out.buffer);
  keys.forEach((key, i) => {
    if (key.raw.length !== KEY_BYTES) throw new Error("A sync key is 32 bytes");
    view.setUint32(i * ENTRY_BYTES, key.version);
    out.set(key.raw, i * ENTRY_BYTES + 4);
  });
  return out;
}

/** Reads a key payload; the wrap's own version must be in it, and it must be the newest. */
export function decodeKeys(payload: Uint8Array, version: number): VersionedKey[] {
  if (!payload.length || payload.length % ENTRY_BYTES !== 0 || payload.length / ENTRY_BYTES > MAX_KEYS) throw new Error("Unknown key payload format");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const keys = Array.from({ length: payload.length / ENTRY_BYTES }, (_, i) => ({
    version: view.getUint32(i * ENTRY_BYTES),
    raw: new Uint8Array(payload.slice(i * ENTRY_BYTES + 4, (i + 1) * ENTRY_BYTES)),
  }));
  if (Math.max(...keys.map((k) => k.version)) !== version || new Set(keys.map((k) => k.version)).size !== keys.length) {
    throw new Error("The key payload does not match its version");
  }
  return keys;
}

/** Wraps a key payload (encodeKeys) so only the device holding `recipientPublicKey` can open it. */
export async function wrapForDevice(syncKey: Uint8Array, recipientPublicKey: string, deviceId: string, version: number): Promise<string> {
  const ephemeral = await generateDeviceKeys();
  const key = await agreeKey(ephemeral.privateKey, recipientPublicKey, fromBase64Url(ephemeral.publicKey), "perch-key-wrap-v1");
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: wrapAad(deviceId, version) }, key, new Uint8Array(syncKey));
  return pack({ v: 1, alg: "p256-hkdf-aesgcm", epk: ephemeral.publicKey, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) });
}

export async function unwrapForDevice(blob: string, keys: DeviceKeys, deviceId: string, version: number): Promise<Bytes> {
  const wrap = unpack<DeviceWrap>(blob);
  if (wrap.v !== 1 || wrap.alg !== "p256-hkdf-aesgcm") throw new Error("Unknown key wrap format");
  const key = await agreeKey(keys.privateKey, wrap.epk, fromBase64Url(wrap.epk), "perch-key-wrap-v1");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(wrap.iv), additionalData: wrapAad(deviceId, version) }, key, fromBase64Url(wrap.ct));
  return new Uint8Array(plain);
}
