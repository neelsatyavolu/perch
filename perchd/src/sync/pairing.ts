/**
 * Pairing codes and grants. A new device shows a 16-character code (or a QR code holding it): an
 * 8-character commitment to its public key and to a secret, then the 8-character secret itself.
 * The server sees only the commitment. The approving device checks the key the server hands it
 * against the whole code, so a server that swaps keys would need the secret it never saw. It then
 * seals a grant to that key with the secret: who approved (their public key, for the relay), the
 * pinned recovery public key, and for a browser the sync keys. A server cannot open or forge it.
 */
import { base32, concat, fromBase64Url, fromUtf8, randomBytes, safeEqual, sha256, toBase64Url, utf8 } from "./encoding";
import { agreeKey, generateDeviceKeys, pack, unpack, type DeviceKeys, type VersionedKey } from "./keys";

export type PairingCode = { lookup: string; secret: string; display: string };
export type Grant = { approver: { id: string; publicKey: string }; recoveryPublicKey?: string; keys?: VersionedKey[] };

const CODE = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const group = (raw: string) => raw.match(/.{4}/g)!.join("-");

/** The commitment the server indexes a request by: 40 bits of SHA-256 over the key and the secret. */
export async function commitment(publicKey: string, secret: string): Promise<string> {
  return group(base32(await sha256(concat(utf8("perch-pair-v2|"), fromBase64Url(publicKey), utf8(`|${secret}`))), 8));
}

/** A fresh code for this device; a new secret every time, so restarting never reuses a code. */
export async function newPairingCode(publicKey: string): Promise<PairingCode> {
  const secret = base32(randomBytes(5), 8);
  const lookup = await commitment(publicKey, secret);
  return { lookup, secret, display: group(lookup.replace("-", "") + secret) };
}

/** What a QR code for the pairing carries. */
export const pairingQrPayload = (code: PairingCode): string => `perch://pair?code=${code.display.replace(/-/g, "")}`;

/** Reads a typed code (any case, spaces, dashes, O/I/L for 0/1) or a scanned QR payload. */
export function parsePairingCode(input: string): { lookup: string; secret: string } {
  const trimmed = input.trim();
  const scanned = /^perch:\/\/pair\?code=([0-9A-Za-z-]{16,19})$/.exec(trimmed)?.[1];
  const raw = (scanned ?? trimmed).toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!CODE.test(raw)) throw new Error("A pairing code has 16 letters and numbers. Check it and try again.");
  return { lookup: group(raw.slice(0, 8)), secret: raw.slice(8) };
}

/** True when the key the server returned is the one the code commits to. */
export async function keyMatchesCode(publicKey: string, code: { lookup: string; secret: string }): Promise<boolean> {
  return safeEqual(await commitment(publicKey, code.secret), code.lookup);
}

type Sealed = { v: 2; epk: string; iv: string; ct: string };
type Body = { approver: { id: string; publicKey: string }; recoveryPublicKey?: string; keys?: { version: number; key: string }[] };

const grantKey = async (privateKey: CryptoKey, peer: string, secret: string) =>
  agreeKey(privateKey, peer, await sha256(utf8(`perch-pair-v2|${secret}`)), "perch-pair-grant-v2");
const grantAad = (pairingId: string) => utf8(`perch-pair-grant-v2|${pairingId}`);

/** Seals a grant to the new device's checked key, bound to the secret and this pairing. */
export async function sealGrant(grant: Grant, recipientPublicKey: string, secret: string, pairingId: string): Promise<string> {
  const ephemeral = await generateDeviceKeys();
  const key = await grantKey(ephemeral.privateKey, recipientPublicKey, secret);
  const body: Body = {
    approver: grant.approver,
    ...(grant.recoveryPublicKey ? { recoveryPublicKey: grant.recoveryPublicKey } : {}),
    ...(grant.keys ? { keys: grant.keys.map((k) => ({ version: k.version, key: toBase64Url(k.raw) })) } : {}),
  };
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: grantAad(pairingId) }, key, utf8(JSON.stringify(body)));
  return pack({ v: 2, epk: ephemeral.publicKey, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) } satisfies Sealed);
}

const isKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{87}$/.test(value);

/** Opens a grant on the new device. Throws if it was not sealed with this pairing's secret. */
export async function openGrant(blob: string, keys: DeviceKeys, secret: string, pairingId: string): Promise<Grant> {
  const sealed = unpack<Sealed>(blob);
  if (sealed.v !== 2) throw new Error("Unknown pairing grant format");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(sealed.iv), additionalData: grantAad(pairingId) }, await grantKey(keys.privateKey, sealed.epk, secret), fromBase64Url(sealed.ct));
  } catch {
    throw new Error("The approval could not be verified. Do not use this pairing; start again.");
  }
  const body = JSON.parse(fromUtf8(new Uint8Array(plain))) as Body;
  if (typeof body.approver?.id !== "string" || !isKey(body.approver.publicKey)) throw new Error("The pairing grant is malformed");
  if (body.recoveryPublicKey !== undefined && !isKey(body.recoveryPublicKey)) throw new Error("The pairing grant is malformed");
  return {
    approver: { id: body.approver.id, publicKey: body.approver.publicKey },
    ...(body.recoveryPublicKey ? { recoveryPublicKey: body.recoveryPublicKey } : {}),
    ...(body.keys ? { keys: body.keys.map((k) => ({ version: k.version, raw: fromBase64Url(k.key) })) } : {}),
  };
}
