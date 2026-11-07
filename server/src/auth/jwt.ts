import { fromBase64Url, safeEqual } from "../crypto";

/**
 * Checks an OpenID Connect ID token with WebCrypto alone: RS256 or ES256 signature from the
 * provider's JWKS (found by `kid`, with one refetch when the id is new), then iss, aud (and azp),
 * exp, nbf, iat and nonce, allowing 60 seconds of clock skew.
 */

export type Jwk = JsonWebKey & { kid?: string; use?: string };
/** The provider's keys. `refresh` asks for a fresh copy instead of the cached one. */
export type JwksSource = (refresh: boolean) => Promise<Jwk[]>;
export type Claims = { iss: string; sub: string; aud: string | string[]; exp: number; iat: number; nonce: string; [claim: string]: unknown };
export type VerifyOptions = { issuer: string; audience: string; nonce: string; jwks: JwksSource; now: number };

export const CLOCK_SKEW_SECONDS = 60;
const MIN_RSA_BYTES = 256;

/** Why a token was refused: a fixed code, safe to log. */
export class JwtError extends Error {
  constructor(readonly reason: string) {
    super(`ID token refused: ${reason}`);
  }
}

const ALGORITHMS = {
  RS256: { kty: "RSA", importAs: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyAs: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", importAs: { name: "ECDSA", namedCurve: "P-256" }, verifyAs: { name: "ECDSA", hash: "SHA-256" } },
} as const;
type Algorithm = (typeof ALGORITHMS)[keyof typeof ALGORITHMS];

function decodeJson(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the refusal below.
  }
  throw new JwtError("malformed");
}

export async function verifyIdToken(token: string, options: VerifyOptions): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new JwtError("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  const algName = header.alg;
  if (typeof algName !== "string" || !Object.hasOwn(ALGORITHMS, algName)) throw new JwtError("bad_alg");
  if (header.crit !== undefined) throw new JwtError("bad_header");
  const alg = ALGORITHMS[algName as keyof typeof ALGORITHMS];
  const key = await findKey(options.jwks, header.kid, algName, alg);
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify(alg.verifyAs, key, fromBase64Url(signaturePart), signed).catch(() => false);
  if (!valid) throw new JwtError("bad_signature");
  return checkClaims(decodeJson(payloadPart), options);
}

async function findKey(jwks: JwksSource, kid: unknown, algName: string, alg: Algorithm): Promise<CryptoKey> {
  if (kid !== undefined && typeof kid !== "string") throw new JwtError("bad_header");
  const pick = (keys: Jwk[]): Jwk | undefined => {
    const fits = keys.filter((k) => k.kty === alg.kty && (!k.use || k.use === "sig") && (!k.alg || k.alg === algName) && (alg.kty !== "EC" || k.crv === "P-256"));
    // With no kid, a key set holding exactly one fitting key is unambiguous.
    return kid === undefined ? (fits.length === 1 ? fits[0] : undefined) : fits.find((k) => k.kid === kid);
  };
  const jwk = pick(await jwks(false)) ?? pick(await jwks(true));
  if (!jwk) throw new JwtError("unknown_key");
  if (alg.kty === "RSA" && fromBase64Url(jwk.n ?? "").length < MIN_RSA_BYTES) throw new JwtError("weak_key");
  const material: JsonWebKey = alg.kty === "RSA" ? { kty: "RSA", n: jwk.n, e: jwk.e } : { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  try {
    return await crypto.subtle.importKey("jwk", material, alg.importAs, false, ["verify"]);
  } catch {
    throw new JwtError("bad_key");
  }
}

function checkClaims(claims: Record<string, unknown>, options: VerifyOptions): Claims {
  const now = Math.floor(options.now / 1000);
  const { iss, sub, aud, azp, exp, iat, nbf, nonce } = claims;
  if (iss !== options.issuer) throw new JwtError("bad_issuer");
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(options.audience)) throw new JwtError("bad_audience");
  // OIDC Core 3.1.3.7: with several audiences, or any azp, azp must be this client.
  if ((audiences.length > 1 || azp !== undefined) && azp !== options.audience) throw new JwtError("bad_audience");
  if (typeof exp !== "number" || exp + CLOCK_SKEW_SECONDS <= now) throw new JwtError("expired");
  if (typeof iat !== "number" || iat - CLOCK_SKEW_SECONDS > now) throw new JwtError("bad_iat");
  if (nbf !== undefined && (typeof nbf !== "number" || nbf - CLOCK_SKEW_SECONDS > now)) throw new JwtError("not_yet_valid");
  if (typeof nonce !== "string" || !safeEqual(nonce, options.nonce)) throw new JwtError("bad_nonce");
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) throw new JwtError("bad_subject");
  return claims as Claims;
}
