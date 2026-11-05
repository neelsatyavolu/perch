/** Time-based one-time passwords (RFC 6238) on WebCrypto HMAC. */

export type Algorithm = "SHA1" | "SHA256" | "SHA512";

const HASH: Record<Algorithm, string> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

export async function totp(
  secret: Uint8Array,
  opts: { time?: number; period?: number; digits?: number; algorithm?: Algorithm } = {},
): Promise<string> {
  const period = opts.period ?? 30;
  const digits = opts.digits ?? 6;
  const time = opts.time ?? Date.now() / 1000;
  const counter = Math.floor(time / period);
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: HASH[opts.algorithm ?? "SHA1"] }, false, ["sign"]);
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  // Dynamic truncation (RFC 4226 section 5.3).
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function secondsLeft(time: number, period: number): number {
  return period - (Math.floor(time) % period);
}
