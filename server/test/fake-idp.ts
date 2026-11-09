/**
 * A fake OpenID Connect provider for tests. It makes its signing keys with WebCrypto and answers
 * discovery, JWKS and the token endpoint through `Deps.fetch`, so no test touches the network.
 * `authorize` plays the person's browser at the provider: it checks the authorization URL Perch
 * built and returns the callback path with a one-time code.
 */
import { fromBase64Url, randomToken, sha256, toBase64Url } from "../src/crypto";

type Alg = "RS256" | "ES256";
type SigningKey = { kid: string; alg: Alg; privateKey: CryptoKey; jwk: JsonWebKey & { kid: string; use: string; alg: Alg } };

export type IdpUser = { sub: string; email?: string; groups?: string[]; preferred_username?: string };
/** Ways to spoil the next ID token, for the refusal tests. */
export type Tamper = { claims?: Record<string, unknown>; header?: Record<string, unknown>; signWith?: "stranger" };

type Grant = { user: IdpUser; nonce: string; challenge: string; redirectUri: string; tamper?: Tamper };

const ALGORITHMS = {
  RS256: { generate: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { generate: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } },
} as const;

async function makeKey(alg: Alg, kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(ALGORITHMS[alg].generate, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const { key_ops: _ops, ext: _ext, ...publicJwk } = jwk;
  return { kid, alg, privateKey: pair.privateKey, jwk: { ...publicJwk, kid, use: "sig", alg } };
}

const encodeJson = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function fakeIdp(options: { alg?: Alg; now: () => number; scopes?: string[] }) {
  const alg = options.alg ?? "RS256";
  const issuer = `https://idp-${randomToken("t", 6).slice(2).toLowerCase().replace(/[^a-z0-9]/g, "x")}.example.com`;
  const clientId = "perch-company-test";
  const clientSecret = randomToken("secret");
  let signing = await makeKey(alg, "key-1");
  const published: SigningKey[] = [signing];
  const stranger = await makeKey(alg, "key-1");
  const grants = new Map<string, Grant>();
  const counts = { discovery: 0, jwks: 0, token: 0 };
  const tokenRequests: URLSearchParams[] = [];

  async function sign(claims: Record<string, unknown>, tamper: Tamper = {}): Promise<string> {
    const key = tamper.signWith === "stranger" ? stranger : signing;
    const header = { alg: key.alg, kid: key.kid, typ: "JWT", ...tamper.header };
    const input = `${encodeJson(header)}.${encodeJson({ ...claims, ...tamper.claims })}`;
    const signature = await crypto.subtle.sign({ ...ALGORITHMS[key.alg].sign }, key.privateKey, new TextEncoder().encode(input));
    return `${input}.${toBase64Url(new Uint8Array(signature))}`;
  }

  async function token(init?: RequestInit): Promise<Response> {
    counts.token++;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (auth !== `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`) return json({ error: "invalid_client" }, 401);
    const form = new URLSearchParams(String(init?.body ?? ""));
    tokenRequests.push(form);
    const code = form.get("code") ?? "";
    const grant = grants.get(code);
    grants.delete(code);
    if (!grant || form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== grant.redirectUri) return json({ error: "invalid_grant" }, 400);
    const challenge = toBase64Url(await sha256(form.get("code_verifier") ?? ""));
    if (challenge !== grant.challenge) return json({ error: "invalid_grant", error_description: "PKCE" }, 400);
    const iat = Math.floor(options.now() / 1000);
    const claims = { iss: issuer, aud: clientId, iat, exp: iat + 300, nonce: grant.nonce, ...grant.user };
    return json({ access_token: "opaque", token_type: "Bearer", expires_in: 300, id_token: await sign(claims, grant.tamper) });
  }

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== issuer) throw new Error(`No network in tests: ${url.origin}`);
    if (url.pathname === "/.well-known/openid-configuration") {
      counts.discovery++;
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        scopes_supported: options.scopes ?? ["openid", "email", "profile", "groups"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        id_token_signing_alg_values_supported: [alg],
      });
    }
    if (url.pathname === "/jwks") {
      counts.jwks++;
      return json({ keys: published.map((k) => k.jwk) });
    }
    if (url.pathname === "/token" && init?.method === "POST") return token(init);
    return json({ error: "not_found" }, 404);
  }) as typeof globalThis.fetch;

  /** The person signs in at the provider; returns the callback path the provider redirects to. */
  function authorize(authorizationUrl: string, user: IdpUser, tamper?: Tamper): string {
    const url = new URL(authorizationUrl);
    const p = url.searchParams;
    if (`${url.origin}${url.pathname}` !== `${issuer}/authorize`) throw new Error("not this provider");
    if (p.get("response_type") !== "code" || p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256") throw new Error("bad authorization request");
    if (!p.get("state") || !p.get("nonce") || !p.get("code_challenge") || !p.get("scope")?.split(" ").includes("openid")) throw new Error("missing parameter");
    const code = randomToken("code", 16);
    const redirectUri = p.get("redirect_uri")!;
    grants.set(code, { user, nonce: p.get("nonce")!, challenge: p.get("code_challenge")!, redirectUri, tamper });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state")!);
    return `${back.pathname}${back.search}`;
  }

  /** Starts signing with a new key; the JWKS then lists both. */
  async function rotate(): Promise<void> {
    signing = await makeKey(alg, `key-${published.length + 1}`);
    published.push(signing);
  }

  return { issuer, clientId, clientSecret, fetch, authorize, rotate, sign, counts, tokenRequests };
}
export type FakeIdp = Awaited<ReturnType<typeof fakeIdp>>;

/** Decodes a JWT's payload, for assertions. */
export const payloadOf = (jwt: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(jwt.split(".")[1]!)));
