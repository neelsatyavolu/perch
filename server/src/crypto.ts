/** Random tokens, hashes and base64url, all on WebCrypto. */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A random id or secret: `prefix_` plus 32 random bytes in base64url. */
export const randomToken = (prefix: string, bytes = 32): string => `${prefix}_${toBase64Url(randomBytes(bytes))}`;

export async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export const sha256Hex = async (input: string | Uint8Array): Promise<string> =>
  [...(await sha256(input))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Crockford base32: no I, L, O or U, so codes read aloud and typed by hand survive. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function base32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += CROCKFORD[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
    if (out.length >= chars) break;
  }
  return out;
}

/** A random 8-character code, shown as `ABCD-EFGH`. */
export const randomCode = (): string => formatCode(base32(randomBytes(5), 8));

export const formatCode = (raw: string): string => `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;

/** Accepts what people type: any case, spaces or dashes, and O/I/L mistaken for 0/1. */
export function normalizeCode(input: string): string {
  const raw = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return raw.length === 8 ? formatCode(raw) : raw;
}

/** Compares two strings in time that does not depend on where they differ. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
