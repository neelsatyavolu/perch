/**
 * Device keys and key wrapping. Each device has a P-256 ECDH key pair; the private half lives in
 * the Keychain. The sync key is wrapped for a device with ECIES (an ephemeral ECDH key, HKDF,
 * AES-256-GCM) and for recovery with PBKDF2-SHA256 from the recovery key or a passphrase.
 */
import { base32, fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8, type Bytes } from "./encoding";

export type DeviceKeys = { publicKey: string; privateKey: CryptoKey };

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
export const RECOVERY_ITERATIONS = 600_000;
/** Cloudflare Workers cap PBKDF2 at 100,000; tests that run there pass this. */
export const MIN_ITERATIONS = 100_000;

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
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: await importPublicKey(peerPublicKey) }, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: utf8(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

type DeviceWrap = { v: 1; alg: "p256-hkdf-aesgcm"; epk: string; iv: string; ct: string };
type RecoveryWrap = { v: 1; alg: "pbkdf2-sha256-aesgcm"; salt: string; iter: number; iv: string; ct: string };

const pack = (value: DeviceWrap | RecoveryWrap) => toBase64Url(utf8(JSON.stringify(value)));
const unpack = <T>(blob: string): T => JSON.parse(fromUtf8(fromBase64Url(blob))) as T;
const wrapAad = (slot: string, version: number) => utf8(`perch-key-wrap-v1|${slot}|${version}`);

/** Wraps the sync key so only the device holding `recipientPublicKey` can open it. */
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

/** A recovery key to write down: 25 base32 characters (125 bits) in five groups of five. */
export function newRecoveryKey(): string {
  return base32(randomBytes(16), 25).match(/.{5}/g)!.join("-");
}

const RECOVERY_KEY = /^[0-9A-Za-z]{5}([\s-]?[0-9A-Za-z]{5}){4}$/;

/** Recovery keys forgive case, spaces and dashes; a chosen passphrase is used exactly (after NFKC). */
function normalizeSecret(secret: string): string {
  const trimmed = secret.normalize("NFKC").trim();
  return RECOVERY_KEY.test(trimmed) ? trimmed.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1") : trimmed;
}

async function passphraseKey(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (iterations < MIN_ITERATIONS) throw new Error(`PBKDF2 needs at least ${MIN_ITERATIONS} iterations`);
  const base = await crypto.subtle.importKey("raw", utf8(normalizeSecret(secret)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Wraps the sync key with the recovery key (or a passphrase the person chose instead). */
export async function wrapWithRecovery(syncKey: Uint8Array, secret: string, version: number, iterations = RECOVERY_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await passphraseKey(secret, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: wrapAad("recovery", version) }, key, new Uint8Array(syncKey));
  return pack({ v: 1, alg: "pbkdf2-sha256-aesgcm", salt: toBase64Url(salt), iter: iterations, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) });
}

export async function unwrapWithRecovery(blob: string, secret: string, version: number): Promise<Bytes> {
  const wrap = unpack<RecoveryWrap>(blob);
  if (wrap.v !== 1 || wrap.alg !== "pbkdf2-sha256-aesgcm" || wrap.iter > 10_000_000) throw new Error("Unknown recovery wrap format");
  const key = await passphraseKey(secret, fromBase64Url(wrap.salt), wrap.iter);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(wrap.iv), additionalData: wrapAad("recovery", version) }, key, fromBase64Url(wrap.ct)));
  } catch {
    throw new Error("That recovery key does not open this account's sync data.");
  }
}

