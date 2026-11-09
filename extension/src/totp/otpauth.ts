/** Parses the otpauth:// URIs that sites put in their setup QR codes. */

import { base32Decode, base32Encode } from "./base32";
import type { Algorithm } from "./totp";

export type Account = {
  issuer: string;
  account: string;
  /** Canonical base32, upper case, no padding. */
  secret: string;
  algorithm: Algorithm;
  digits: number;
  period: number;
};

/** 80 bits: the shortest secret common sites still issue. */
const MIN_SECRET_BYTES = 10;
const MAX_TEXT = 200;

export function parseOtpauth(uri: string): Account {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Error("This is not a setup code for an authenticator.");
  }
  if (url.protocol !== "otpauth:") throw new Error("This is not a setup code for an authenticator.");
  if (url.hostname === "hotp") throw new Error("Perch supports time-based codes only, not counter-based (HOTP) codes.");
  if (url.hostname !== "totp") throw new Error("This is not a setup code for an authenticator.");

  const label = safeDecode(url.pathname.replace(/^\/+/, ""));
  const colon = label.indexOf(":");
  const labelIssuer = colon === -1 ? "" : label.slice(0, colon).trim();
  const account = (colon === -1 ? label : label.slice(colon + 1)).trim();
  const issuer = (url.searchParams.get("issuer") ?? labelIssuer).trim();

  return {
    issuer: limit(issuer),
    account: limit(account),
    secret: checkSecret(url.searchParams.get("secret") ?? ""),
    algorithm: checkAlgorithm(url.searchParams.get("algorithm")),
    digits: checkNumber(url.searchParams.get("digits"), 6, [6, 8], "digits"),
    period: checkNumber(url.searchParams.get("period"), 30, [1, 300], "period"),
  };
}

/** Validates a setup key typed by hand and returns it in canonical form. */
export function checkSecret(secret: string): string {
  const bytes = base32Decode(secret);
  if (bytes.length < MIN_SECRET_BYTES) throw new Error("The setup key is too short to be a real one.");
  return base32Encode(bytes);
}

function checkAlgorithm(value: string | null): Algorithm {
  const name = (value ?? "SHA1").toUpperCase();
  if (name === "SHA1" || name === "SHA256" || name === "SHA512") return name;
  throw new Error(`The code uses an algorithm Perch does not support (${limit(name)}).`);
}

function checkNumber(value: string | null, fallback: number, range: [number, number], name: string): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < range[0] || n > range[1]) {
    throw new Error(`The code's ${name} value (${limit(value)}) is not supported.`);
  }
  return n;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function limit(text: string): string {
  return text.slice(0, MAX_TEXT);
}
