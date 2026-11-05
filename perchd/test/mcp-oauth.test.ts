import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connectRemote } from "../src/mcp-client/http";
import { clientAccount, OAuthProvider, parseWwwAuthenticate, tokenAccount } from "../src/mcp-client/oauth";
import { MemoryKeychain } from "../src/secure/keychain";
import { createFixture } from "./fixtures/mcp-fixture";

/** A fake authorization server and an MCP server that needs its tokens. Every token is made up here. */
const state = { issued: 0, refreshed: 0, registered: 0, lastAuthorize: null as URLSearchParams | null, expiresIn: 3600, challenge: "" };
const codes = new Map<string, string>();
const valid = new Set<string>();
const fixture = createFixture();

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const origin = url.origin;
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ["notes"] });
    if (url.pathname === "/.well-known/oauth-authorization-server/as")
      return Response.json({ issuer: `${origin}/as`, authorization_endpoint: `${origin}/as/authorize`, token_endpoint: `${origin}/as/token`, registration_endpoint: `${origin}/as/register`, code_challenge_methods_supported: ["S256"] });
    if (url.pathname === "/as/register") {
      state.registered++;
      const body = await req.json();
      return Response.json({ client_id: `client-${state.registered}`, redirect_uris: body.redirect_uris });
    }
    if (url.pathname === "/as/authorize") {
      // Stands in for the user approving the sign-in page: redirect straight back with a code.
      state.lastAuthorize = url.searchParams;
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, url.searchParams.get("code_challenge")!);
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      return Response.redirect(back.toString(), 302);
    }
    if (url.pathname === "/as/token") {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") === "authorization_code") {
        const challenge = codes.get(form.get("code") ?? "");
        const expected = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!challenge || challenge !== expected) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(form.get("code")!);
      } else if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== "fake-refresh") return Response.json({ error: "invalid_grant" }, { status: 400 });
        state.refreshed++;
      } else return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      const token = `fake-access-${++state.issued}`;
      valid.add(token);
      return Response.json({ access_token: token, token_type: "Bearer", expires_in: state.expiresIn, refresh_token: "fake-refresh" });
    }
    if (url.pathname === "/mcp") {
      const auth = req.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!auth || !valid.has(auth)) return new Response("sign in", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const out = await fixture.handle(await req.json());
      return out.length ? Response.json(out[0], { headers: { "Mcp-Session-Id": "s" } }) : new Response(null, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

/** Follows the sign-in link the way the user's browser tab would. */
const openUrl = async (url: string) => {
  const res = await fetch(url, { redirect: "follow" });
  expect(await res.text()).toContain("Perch is signed in.");
};

test("WWW-Authenticate parameters are read", () => {
  expect(parseWwwAuthenticate('Bearer error="invalid_token", resource_metadata="https://x.test/.well-known/oauth-protected-resource", scope="a b"')).toEqual({
    resourceMetadata: "https://x.test/.well-known/oauth-protected-resource",
    scope: "a b",
  });
});

test("a server that needs OAuth: discovery, registration, PKCE sign-in, tokens kept in the Keychain", async () => {
  const kc = new MemoryKeychain();
  const auth = new OAuthProvider({ server: "notes", serverUrl: `${base}/mcp`, keychain: kc, openUrl });
  const client = await connectRemote("http", { url: `${base}/mcp`, headers: {}, auth });
  expect((await client.callTool("echo", { text: "signed in" })).content[0]).toEqual({ type: "text", text: "signed in" });
  await client.close();
  const params = state.lastAuthorize!;
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("resource")).toBe(`${base}/mcp`);
  expect(params.get("scope")).toBe("notes");
  expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  expect(kc.accounts().sort()).toEqual([clientAccount("notes"), tokenAccount("notes")]);
  expect(JSON.parse((await kc.get(tokenAccount("notes")))!).access_token).toBe("fake-access-1");

  // A second connection reuses the stored token: no new sign-in.
  const again = await connectRemote("http", { url: `${base}/mcp`, headers: {}, auth: new OAuthProvider({ server: "notes", serverUrl: `${base}/mcp`, keychain: kc, openUrl: async () => { throw new Error("should not ask again"); } }) });
  await again.close();
  expect(state.issued).toBe(1);
});

test("an expired token is refreshed without a new sign-in", async () => {
  const kc = new MemoryKeychain();
  let now = Date.now();
  const auth = new OAuthProvider({ server: "notes", serverUrl: `${base}/mcp`, keychain: kc, openUrl, now: () => now });
  await (await connectRemote("http", { url: `${base}/mcp`, headers: {}, auth })).close();
  const before = state.refreshed;
  now += 2 * 3600 * 1000;
  expect(await auth.header()).toMatch(/^Bearer fake-access-\d+$/);
  expect(state.refreshed).toBe(before + 1);
  await auth.signOut();
  expect(kc.accounts()).toEqual([]);
});

test("a sign-in callback with the wrong state is refused", async () => {
  const kc = new MemoryKeychain();
  const tamper = async (url: string) => {
    const u = new URL(url);
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "stolen");
    back.searchParams.set("state", "wrong");
    expect((await fetch(back)).status).toBe(400);
  };
  const auth = new OAuthProvider({ server: "notes", serverUrl: `${base}/mcp`, keychain: kc, openUrl: tamper, timeoutMs: 300 });
  await expect(connectRemote("http", { url: `${base}/mcp`, headers: {}, auth })).rejects.toThrow("Sign-in timed out");
  expect(await kc.get(tokenAccount("notes"))).toBeNull();
});

test("signing in again reuses the registered client and its redirect address", async () => {
  const kc = new MemoryKeychain();
  const signIn = () => new OAuthProvider({ server: "notes", serverUrl: `${base}/mcp`, keychain: kc, openUrl }).unauthorized(null);
  expect(await signIn()).toBe(true);
  const registered = state.registered;
  const firstRedirect = state.lastAuthorize!.get("redirect_uri");
  await kc.delete(tokenAccount("notes"));
  expect(await signIn()).toBe(true);
  expect(state.registered).toBe(registered);
  expect(state.lastAuthorize!.get("redirect_uri")).toBe(firstRedirect);
  // When that port is taken, Perch picks another one and registers for it.
  const port = Number(new URL(firstRedirect!).port);
  const squatter = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("other app") });
  try {
    await kc.delete(tokenAccount("notes"));
    expect(await signIn()).toBe(true);
    expect(state.registered).toBe(registered + 1);
    expect(state.lastAuthorize!.get("redirect_uri")).not.toBe(firstRedirect);
  } finally {
    squatter.stop(true);
  }
});

test("only one refresh runs when several requests find the token expired", async () => {
  const kc = new MemoryKeychain();
  let now = Date.now();
  const auth = new OAuthProvider({ server: "notes", serverUrl: `${base}/mcp`, keychain: kc, openUrl, now: () => now });
  await auth.unauthorized(null);
  const before = state.refreshed;
  now += 2 * 3600 * 1000;
  const headers = await Promise.all([auth.header(), auth.header(), auth.header()]);
  expect(state.refreshed).toBe(before + 1);
  expect(new Set(headers).size).toBe(1);
});

/** The fixture's answers with one metadata document changed, as a lying server would send it. */
function rewriting(path: string, change: (doc: Record<string, unknown>) => Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    if (new URL(String(input)).pathname !== path) return res;
    return Response.json(change(await res.json()));
  }) as typeof fetch;
}

test("sign-in details that name another issuer or another resource are refused", async () => {
  const kc = new MemoryKeychain();
  const wrongIssuer = new OAuthProvider({ server: "notes", serverUrl: `${base}/mcp`, keychain: kc, openUrl, fetch: rewriting("/.well-known/oauth-authorization-server/as", (d) => ({ ...d, issuer: "https://attacker.test/as" })) });
  await expect(wrongIssuer.unauthorized(null)).rejects.toThrow("The sign-in server's details are for a different server");
  const wrongResource = new OAuthProvider({ server: "notes", serverUrl: `${base}/mcp`, keychain: kc, openUrl, fetch: rewriting("/.well-known/oauth-protected-resource/mcp", (d) => ({ ...d, resource: "https://attacker.test/mcp" })) });
  await expect(wrongResource.unauthorized(null)).rejects.toThrow("The server's sign-in details are for a different address");
  expect(kc.accounts()).toEqual([]);
});
