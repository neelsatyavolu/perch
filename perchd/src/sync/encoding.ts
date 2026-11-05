/** Byte helpers shared by the sync client. Standard Web APIs only, so the code also runs in a Worker. */

export type Bytes = Uint8Array<ArrayBuffer>;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const utf8 = (text: string): Bytes => new Uint8Array(new TextEncoder().encode(text));
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const randomBytes = (length: number): Bytes => crypto.getRandomValues(new Uint8Array(length));

export async function sha256(bytes: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

/** Crockford base32, the alphabet of pairing and recovery codes. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function base32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += CROCKFORD[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  return out;
}

/** Accepts codes as people type them: any case, spaces or dashes, O/I/L for 0/1; groups of four. */
export function normalizeCode(input: string): string {
  const raw = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return raw.length % 4 === 0 && raw.length > 0 ? raw.match(/.{4}/g)!.join("-") : raw;
}

/** Compares in time that does not depend on where the strings differ. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
