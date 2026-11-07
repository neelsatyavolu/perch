import { z } from "zod";
import type { AppEnv, Deps } from "../env";
import { HttpError } from "../http";
import { type Claims, type Jwk, verifyIdToken } from "./jwt";

/**
 * Talking to the company's OpenID Connect provider: discovery, its signing keys and the code
 * exchange. Discovery and keys are cached per Worker isolate for an hour.
 */

export const PROVIDER_CACHE_MS = 60 * 60 * 1000;

export type OidcConfig = { issuer: string; clientId: string; clientSecret: string; adminGroup?: string; redirectUri: string };

/** A provider step that failed. `reason` is a fixed code, safe to log. */
export class ProviderError extends Error {
  constructor(readonly reason: string) {
    super(`Identity provider step failed: ${reason}`);
  }
}

/** The company settings, or 503 when company mode is on but sign-in is not set up. */
export function oidcConfig(env: AppEnv): OidcConfig {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret } = env;
  if (!issuer || !clientId || !clientSecret || !/^https:\/\//.test(issuer)) {
    throw new HttpError(503, "not_configured", "Sign-in through your company is not set up on this server yet. Ask your IT team.");
  }
  return { issuer, clientId, clientSecret, adminGroup: env.OIDC_ADMIN_GROUP || undefined, redirectUri: `${env.API_ORIGIN}/v1/auth/oidc/callback` };
}

const httpsUrl = z.url().refine((u) => u.startsWith("https://"), "must use https");
const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: httpsUrl,
  token_endpoint: httpsUrl,
  jwks_uri: httpsUrl,
  scopes_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});
export type Discovery = z.infer<typeof discoverySchema>;

const jwkSchema = z.object({ kty: z.string(), kid: z.string().optional() }).passthrough();
const jwksSchema = z.object({ keys: z.array(jwkSchema) });
const tokenSchema = z.object({ id_token: z.string().min(1).max(16 * 1024) });

const discoveries = new Map<string, { value: Discovery; at: number }>();
const keySets = new Map<string, { keys: Jwk[]; at: number }>();

async function getJson(deps: Deps, url: string, reason: string): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { Accept: "application/json" }, redirect: "manual" });
  } catch {
    throw new ProviderError(reason);
  }
  if (!response.ok) throw new ProviderError(reason);
  return response.json().catch(() => {
    throw new ProviderError(reason);
  });
}

export async function discover(deps: Deps, issuer: string): Promise<Discovery> {
  const now = deps.now();
  const cached = discoveries.get(issuer);
  if (cached && now - cached.at < PROVIDER_CACHE_MS) return cached.value;
  const raw = await getJson(deps, `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, "discovery_failed");
  const parsed = discoverySchema.safeParse(raw);
  // The document must name the issuer Perch was set up with, exactly (OIDC Discovery 4.3).
  if (!parsed.success || parsed.data.issuer !== issuer) throw new ProviderError("discovery_invalid");
  discoveries.set(issuer, { value: parsed.data, at: now });
  return parsed.data;
}

function keySource(deps: Deps, jwksUri: string) {
  return async (refresh: boolean): Promise<Jwk[]> => {
    const now = deps.now();
    const cached = keySets.get(jwksUri);
    if (cached && !refresh && now - cached.at < PROVIDER_CACHE_MS) return cached.keys;
    const parsed = jwksSchema.safeParse(await getJson(deps, jwksUri, "jwks_failed"));
    if (!parsed.success) throw new ProviderError("jwks_invalid");
    const keys = parsed.data.keys as Jwk[];
    keySets.set(jwksUri, { keys, at: now });
    return keys;
  };
}

/** The scopes to ask for: `groups` only when the provider says it knows it (Entra and Google refuse it). */
export function scopesFor(provider: Discovery): string {
  return ["openid", "email", "profile", ...(provider.scopes_supported?.includes("groups") ? ["groups"] : [])].join(" ");
}

/**
 * Swaps the code for tokens (client secret and PKCE verifier) and verifies the ID token. The
 * secret goes in a Basic header, the OAuth default, unless the provider lists only the form post.
 */
export async function exchangeCode(deps: Deps, config: OidcConfig, provider: Discovery, code: string, verifier: string, nonce: string): Promise<Claims> {
  const methods = provider.token_endpoint_auth_methods_supported;
  const usePost = !!methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post");
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (usePost) {
    form.set("client_id", config.clientId);
    form.set("client_secret", config.clientSecret);
  } else {
    headers.Authorization = `Basic ${btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)}`;
  }
  let response: Response;
  try {
    response = await deps.fetch(provider.token_endpoint, { method: "POST", headers, body: form.toString(), redirect: "manual" });
  } catch {
    throw new ProviderError("token_failed");
  }
  if (!response.ok) throw new ProviderError("token_refused");
  const tokens = tokenSchema.safeParse(await response.json().catch(() => null));
  if (!tokens.success) throw new ProviderError("token_invalid");
  return verifyIdToken(tokens.data.id_token, {
    issuer: config.issuer,
    audience: config.clientId,
    nonce,
    jwks: keySource(deps, provider.jwks_uri),
    now: deps.now(),
  });
}
