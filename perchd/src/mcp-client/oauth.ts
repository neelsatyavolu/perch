/**
 * OAuth for remote MCP servers that require it (MCP authorization spec, 2025-06-18): protected
 * resource metadata (RFC 9728), authorization server metadata (RFC 8414 / OpenID discovery),
 * dynamic client registration (RFC 7591), the authorization code flow with PKCE and a loopback
 * redirect (RFC 8252), resource indicators (RFC 8707), and refresh. Tokens and the registered
 * client live in the Keychain, never in a file.
 */

import { createHash, randomBytes } from "node:crypto";
import type { SecretStore } from "../secure/keychain";
import type { AuthProvider } from "./sse";

export type OAuthOptions = {
  server: string;
  serverUrl: string;
  keychain: SecretStore;
  /** Shows the sign-in page to the user: in Perch, a new tab. */
  openUrl: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

type Tokens = { access_token: string; token_type?: string; refresh_token?: string; expires_at?: number; token_endpoint: string; client_id: string };
type Client = { client_id: string; client_secret?: string; redirect_uri: string; registration_for: string };
type AsMeta = { issuer?: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; code_challenge_methods_supported?: string[] };

const LOOPBACK = "127.0.0.1";
const EXPIRY_MARGIN_MS = 60_000;

export const tokenAccount = (server: string) => `mcp/${server}/oauth-tokens`;
export const clientAccount = (server: string) => `mcp/${server}/oauth-client`;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** https everywhere; plain http only on this Mac, for local servers and tests. */
function checkEndpoint(raw: unknown, what: string): string {
  if (typeof raw !== "string") throw new Error(`The sign-in server did not give a ${what}.`);
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === LOOPBACK;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`The sign-in server's ${what} is not https.`);
  return url.toString();
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** RFC 9728 3.3: the metadata's resource must be the server's address (same origin, a prefix of its path). */
function covers(resource: string, server: URL): boolean {
  try {
    const r = new URL(resource);
    const path = trimSlash(r.pathname);
    return r.origin === server.origin && (path === "" || server.pathname === path || server.pathname.startsWith(`${path}/`) || trimSlash(server.pathname) === path);
  } catch {
    return false;
  }
}

export function parseWwwAuthenticate(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header) return {};
  const param = (name: string) => header.match(new RegExp(`${name}="([^"]*)"`, "i"))?.[1] ?? header.match(new RegExp(`${name}=([^\\s,]+)`, "i"))?.[1];
  return { resourceMetadata: param("resource_metadata"), scope: param("scope") };
}

export class OAuthProvider implements AuthProvider {
  private flow: Promise<boolean> | null = null;
  private refreshing: Promise<Tokens | null> | null = null;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: OAuthOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async header(): Promise<string | undefined> {
    const tokens = await this.tokens();
    if (!tokens) return undefined;
    if (tokens.expires_at && tokens.expires_at - EXPIRY_MARGIN_MS < this.now()) {
      // One refresh at a time: servers that rotate refresh tokens reject the second use.
      this.refreshing ??= (tokens.refresh_token ? this.refresh(tokens).catch(() => null) : Promise.resolve(null)).finally(() => {
        this.refreshing = null;
      });
      const fresh = await this.refreshing;
      if (!fresh) {
        await this.opts.keychain.delete(tokenAccount(this.opts.server));
        return undefined;
      }
      return `Bearer ${fresh.access_token}`;
    }
    return `Bearer ${tokens.access_token}`;
  }

  /** Runs the sign-in once even when several requests hit a 401 together. */
  unauthorized(wwwAuthenticate: string | null): Promise<boolean> {
    this.flow ??= this.signIn(wwwAuthenticate).finally(() => {
      this.flow = null;
    });
    return this.flow;
  }

  async signOut(): Promise<void> {
    await this.opts.keychain.delete(tokenAccount(this.opts.server));
    await this.opts.keychain.delete(clientAccount(this.opts.server));
  }

  private async tokens(): Promise<Tokens | null> {
    const raw = await this.opts.keychain.get(tokenAccount(this.opts.server));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Tokens;
    } catch {
      return null;
    }
  }

  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    const res = await this.doFetch(url, { headers: { Accept: "application/json", "MCP-Protocol-Version": "2025-06-18" } }).catch(() => null);
    if (!res?.ok) {
      await res?.body?.cancel().catch(() => undefined);
      return null;
    }
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  }

  private async discover(www: string | null): Promise<{ meta: AsMeta; scope?: string; resource: string }> {
    const server = new URL(this.opts.serverUrl);
    const hint = parseWwwAuthenticate(www);
    const path = server.pathname === "/" ? "" : server.pathname;
    const prmUrls = [hint.resourceMetadata, `${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
    let prm: Record<string, unknown> | null = null;
    for (const url of prmUrls) if ((prm = await this.getJson(url))) break;
    if (typeof prm?.resource === "string" && !covers(prm.resource, server)) throw new Error("The server's sign-in details are for a different address, so Perch will not use them.");
    const asUrl = new URL(Array.isArray(prm?.authorization_servers) && typeof prm.authorization_servers[0] === "string" ? prm.authorization_servers[0] : server.origin);
    const asPath = asUrl.pathname === "/" ? "" : asUrl.pathname.replace(/\/$/, "");
    const candidates = [
      `${asUrl.origin}/.well-known/oauth-authorization-server${asPath}`,
      `${asUrl.origin}/.well-known/openid-configuration${asPath}`,
      ...(asPath ? [`${asUrl.origin}${asPath}/.well-known/openid-configuration`] : []),
    ];
    let raw: Record<string, unknown> | null = null;
    for (const url of candidates) if ((raw = await this.getJson(url))) break;
    // RFC 8414 3.3: the issuer must be the address the metadata was looked up for.
    if (raw && typeof raw.issuer === "string" && trimSlash(raw.issuer) !== trimSlash(`${asUrl.origin}${asPath}`)) throw new Error("The sign-in server's details are for a different server, so Perch will not use them.");
    // Servers from before metadata discovery use fixed paths on the server's own origin.
    const meta: AsMeta = raw
      ? {
          authorization_endpoint: checkEndpoint(raw.authorization_endpoint, "authorization address"),
          token_endpoint: checkEndpoint(raw.token_endpoint, "token address"),
          ...(raw.registration_endpoint ? { registration_endpoint: checkEndpoint(raw.registration_endpoint, "registration address") } : {}),
          ...(Array.isArray(raw.code_challenge_methods_supported) ? { code_challenge_methods_supported: raw.code_challenge_methods_supported as string[] } : {}),
        }
      : { authorization_endpoint: `${asUrl.origin}/authorize`, token_endpoint: `${asUrl.origin}/token`, registration_endpoint: `${asUrl.origin}/register` };
    if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes("S256")) throw new Error("The sign-in server does not support PKCE (S256), so Perch will not use it.");
    const scopes = Array.isArray(prm?.scopes_supported) ? (prm.scopes_supported as string[]).join(" ") : undefined;
    const resource = typeof prm?.resource === "string" ? prm.resource : `${server.origin}${server.pathname}`;
    return { meta, scope: hint.scope ?? scopes, resource };
  }

  /** The client registered earlier with this sign-in server, if any. */
  private async storedClient(meta: AsMeta): Promise<Client | null> {
    const stored = await this.opts.keychain.get(clientAccount(this.opts.server));
    if (!stored) return null;
    try {
      const client = JSON.parse(stored) as Client;
      return client.registration_for === meta.token_endpoint ? client : null;
    } catch {
      return null;
    }
  }

  private async register(meta: AsMeta, redirectUri: string, stored: Client | null): Promise<Client> {
    if (stored?.redirect_uri === redirectUri) return stored;
    if (!meta.registration_endpoint) throw new Error("The server needs a registered app and does not allow automatic registration. Add a client id in the server's settings.");
    const res = await this.doFetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_name: "Perch", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (!res.ok) throw new Error(`Registering Perch with the sign-in server failed (HTTP ${res.status}).`);
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.client_id !== "string") throw new Error("The sign-in server did not return a client id.");
    const client: Client = { client_id: body.client_id, ...(typeof body.client_secret === "string" ? { client_secret: body.client_secret } : {}), redirect_uri: redirectUri, registration_for: meta.token_endpoint };
    await this.opts.keychain.set(clientAccount(this.opts.server), JSON.stringify(client));
    return client;
  }

  private async signIn(www: string | null): Promise<boolean> {
    const { meta, scope, resource } = await this.discover(www);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    // Listen on the port registered last time, so the same client keeps working; another port means a new registration.
    const stored = await this.storedClient(meta);
    const callback = waitForCallback(state, this.opts.timeoutMs ?? 300_000, stored ? loopbackPort(stored.redirect_uri) : 0);
    try {
      const redirectUri = `http://${LOOPBACK}:${callback.port}/callback`;
      const client = await this.register(meta, redirectUri, stored);
      const auth = new URL(meta.authorization_endpoint);
      const params: Record<string, string> = {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        state,
        resource,
        ...(scope ? { scope } : {}),
      };
      for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v);
      await this.opts.openUrl(auth.toString());
      const code = await callback.code;
      await this.exchange(meta.token_endpoint, client, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, resource });
      return true;
    } finally {
      callback.stop();
    }
  }

  private async exchange(tokenEndpoint: string, client: Pick<Client, "client_id" | "client_secret">, form: Record<string, string>): Promise<Tokens> {
    const body = new URLSearchParams({ ...form, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) });
    const res = await this.doFetch(tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    if (!res.ok) throw new Error(`The sign-in server refused the token request (HTTP ${res.status}).`);
    const t = (await res.json()) as Record<string, unknown>;
    if (typeof t.access_token !== "string") throw new Error("The sign-in server did not return an access token.");
    const tokens: Tokens = {
      access_token: t.access_token,
      ...(typeof t.token_type === "string" ? { token_type: t.token_type } : {}),
      ...(typeof t.refresh_token === "string" ? { refresh_token: t.refresh_token } : form.refresh_token ? { refresh_token: form.refresh_token } : {}),
      ...(typeof t.expires_in === "number" ? { expires_at: this.now() + t.expires_in * 1000 } : {}),
      token_endpoint: tokenEndpoint,
      client_id: client.client_id,
    };
    await this.opts.keychain.set(tokenAccount(this.opts.server), JSON.stringify(tokens));
    return tokens;
  }

  private async refresh(tokens: Tokens): Promise<Tokens> {
    const stored = await this.opts.keychain.get(clientAccount(this.opts.server));
    const client = stored ? (JSON.parse(stored) as Client) : { client_id: tokens.client_id };
    return this.exchange(tokens.token_endpoint, client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token! });
  }
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Perch</title><body style="font:14px -apple-system,sans-serif;background:#000;color:#eee;padding:48px">Perch is signed in. You can close this tab.</body>`;

function loopbackPort(uri: string): number {
  try {
    const url = new URL(uri);
    return url.hostname === LOOPBACK && url.port ? Number(url.port) : 0;
  } catch {
    return 0;
  }
}

/** A one-shot loopback server for the redirect. It checks state, so another page cannot inject a code. */
function waitForCallback(state: string, timeoutMs: number, preferredPort = 0): { port: number; code: Promise<string>; stop: () => void } {
  let settle: { resolve: (c: string) => void; reject: (e: Error) => void } = { resolve: () => undefined, reject: () => undefined };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  code.catch(() => undefined);
  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
    if (url.searchParams.get("state") !== state) return new Response("This sign-in link has expired. Start again from Perch.", { status: 400 });
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    if (error || !got) {
      settle.reject(new Error(`Sign-in was not completed${error ? ` (${error.slice(0, 60)})` : ""}.`));
      return new Response("Sign-in was not completed. You can close this tab.", { status: 400 });
    }
    settle.resolve(got);
    return new Response(DONE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
  const listen = (port: number) => Bun.serve({ hostname: LOOPBACK, port, fetch: handler });
  let server: ReturnType<typeof listen>;
  try {
    server = listen(preferredPort);
  } catch {
    server = listen(0); // the old port is taken by another app
  }
  const timer = setTimeout(() => settle.reject(new Error("Sign-in timed out. Try again.")), timeoutMs);
  return {
    port: server.port!,
    code,
    stop: () => {
      clearTimeout(timer);
      server.stop(true);
    },
  };
}
