/**
 * Recovery (spec 11.1, 11.3). At setup Perch makes a recovery key the person writes down, and a
 * recovery key pair. The pair's private half is sealed with the recovery key (PBKDF2-SHA256); the
 * sync key is wrapped to its public half like any device. So a key rotation can re-wrap for
 * recovery without asking for the recovery key, and only someone holding it can open the copy.
 * Devices pin the recovery public key, so a server cannot swap in its own.
 */
import { base32, fromBase64Url, randomBytes, toBase64Url, utf8, type Bytes } from "./encoding";
import { exportDeviceKeys, generateDeviceKeys, importDeviceKeys, pack, unpack, unwrapForDevice, wrapForDevice } from "./keys";

export const RECOVERY_ITERATIONS = 600_000;
/** Cloudflare Workers cap PBKDF2 at 100,000; tests that run there pass this. */
export const MIN_ITERATIONS = 100_000;
const MIN_PASSPHRASE = 12;

type Sealed = { salt: string; iter: number; iv: string; ct: string };
type RecoveryBlob = { v: 1; alg: "recovery-v1"; pk: string; sk: Sealed; key: string };
export type RecoveryKit = { publicKey: string; sealed: Sealed };

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

async function secretKey(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (iterations < MIN_ITERATIONS || iterations > 10_000_000) throw new Error(`PBKDF2 needs between ${MIN_ITERATIONS} and 10,000,000 iterations`);
  const base = await crypto.subtle.importKey("raw", utf8(normalizeSecret(secret)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const SEAL_AAD = utf8("perch-recovery-v1");

/** Makes the recovery key pair and seals its private half with the secret. */
export async function createRecoveryKit(secret: string, iterations = RECOVERY_ITERATIONS): Promise<RecoveryKit> {
  if (normalizeSecret(secret).length < MIN_PASSPHRASE) throw new Error(`Use a recovery passphrase of at least ${MIN_PASSPHRASE} characters.`);
  const pair = await generateDeviceKeys();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await secretKey(secret, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: SEAL_AAD }, key, utf8(await exportDeviceKeys(pair)));
  return { publicKey: pair.publicKey, sealed: { salt: toBase64Url(salt), iter: iterations, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) } };
}

/** The recovery copy of the sync key at a version, for the server's "recovery" slot. */
export async function recoveryBlob(syncKey: Uint8Array, version: number, kit: RecoveryKit): Promise<string> {
  const key = await wrapForDevice(syncKey, kit.publicKey, "recovery", version);
  return pack({ v: 1, alg: "recovery-v1", pk: kit.publicKey, sk: kit.sealed, key } satisfies RecoveryBlob);
}

/** Reads the kit out of a stored recovery copy, checking it against the pinned public key. */
export function recoveryKitFrom(blob: string, pinnedPublicKey: string): RecoveryKit {
  const parsed = parse(blob);
  if (parsed.pk !== pinnedPublicKey) throw new Error("The server's recovery copy does not match this device's. Do not trust it.");
  return { publicKey: parsed.pk, sealed: parsed.sk };
}

function parse(blob: string): RecoveryBlob {
  const parsed = unpack<RecoveryBlob>(blob);
  if (parsed.v !== 1 || parsed.alg !== "recovery-v1") throw new Error("Unknown recovery copy format");
  return parsed;
}

/** Opens a recovery copy with the recovery key. Returns the sync key and the recovery public key to pin. */
export async function openRecovery(blob: string, secret: string, version: number): Promise<{ syncKey: Bytes; publicKey: string }> {
  const parsed = parse(blob);
  const key = await secretKey(secret, fromBase64Url(parsed.sk.salt), parsed.sk.iter);
  let serialized: ArrayBuffer;
  try {
    serialized = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(parsed.sk.iv), additionalData: SEAL_AAD }, key, fromBase64Url(parsed.sk.ct));
  } catch {
    throw new Error("That recovery key does not open this account's sync data.");
  }
  const pair = await importDeviceKeys(new TextDecoder().decode(serialized));
  if (pair.publicKey !== parsed.pk) throw new Error("The recovery copy is damaged.");
  return { syncKey: await unwrapForDevice(parsed.key, pair, "recovery", version), publicKey: parsed.pk };
}
