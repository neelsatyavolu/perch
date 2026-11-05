import { afterEach, expect, test } from "bun:test";
import { memoryKeychain } from "../src/config/keychain";
import { createSubscriptionAuth } from "../src/models/oauth";
import { fakeServer, json, type FakeServer } from "./fixtures/fake-providers";

let server: FakeServer | null = null;
const disposers: (() => void)[] = [];
afterEach(() => {
  server?.stop();
  disposers.splice(0).forEach((d) => d());
});

/** Sends every request (the real token URLs) to the fake server, keeping the path. */
const via = (fake: FakeServer): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => fetch(`${fake.url}${new URL(String(url)).pathname}`, init)) as typeof fetch;

// An id token whose payload names a ChatGPT account.
const idToken = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { organizations: [{ id: "org-9", is_default: true }] } })).toString("base64url")}.y`;

function tokenServer(responses: object[] = [{ access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600, id_token: idToken }]) {
  let n = 0;
  return fakeServer((req) => {
    if (req.path.endsWith("/token")) {
      const r = responses[Math.min(n++, responses.length - 1)]!;
      return "status" in r ? json(r, (r as { status: number }).status) : json(r);
    }
    return json({}, 404);
  });
}

function setup(opts: { now?: () => number } = {}) {
  const keychain = memoryKeychain();
  let changes = 0;
  const auth = createSubscriptionAuth({ keychain, fetch: via(server!), ports: { codex: 0, grok: 0 }, now: opts.now, onChange: () => changes++ });
  disposers.push(auth.dispose);
  return { keychain, auth, changes: () => changes };
}

test("ChatGPT sign-in: PKCE URL, loopback callback, tokens in the Keychain", async () => {
  server = tokenServer();
  const { keychain, auth, changes } = setup();
  const start = await auth.startSignIn("codex");
  const url = new URL(start.url);
  expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(start.needsPaste).toBe(false);
  const port = auth.listenerPort("codex");
  expect(port).toBeGreaterThan(0);
  const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=${url.searchParams.get("state")}`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Perch is signed in");
  expect(await auth.status("codex")).toBe("signed-in");
  expect(changes()).toBe(1);
  const tokenReq = server.seen.find((s) => s.path === "/oauth/token")!;
  expect(String(tokenReq.body)).toContain("grant_type=authorization_code");
  expect(String(tokenReq.body)).toContain("code_verifier=");
  const stored = JSON.parse((await keychain.get("oauth:codex"))!);
  expect(stored).toMatchObject({ accessToken: "acc-1", refreshToken: "ref-1", accountId: "org-9" });
  expect(await auth.tokens("codex")).toEqual({ accessToken: "acc-1", accountId: "org-9" });
});

test("a callback with the wrong state is ignored and the listener keeps waiting", async () => {
  server = tokenServer();
  const { auth } = setup();
  await auth.startSignIn("codex");
  const port = auth.listenerPort("codex");
  const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=forged`);
  expect(res.status).toBe(400);
  expect(auth.listenerPort("codex")).toBe(port);
  expect(await auth.status("codex")).toBe("signed-out");
});

test("Grok sign-in with a pasted bare code", async () => {
  server = tokenServer([{ access_token: "g-acc", refresh_token: "g-ref", expires_in: 3600 }]);
  const { auth } = setup();
  const start = await auth.startSignIn("grok");
  expect(new URL(start.url).hostname).toBe("auth.x.ai");
  expect(start.needsPaste).toBe(true);
  await auth.finishSignIn("grok", "  bare-code-123 ");
  expect(await auth.tokens("grok")).toEqual({ accessToken: "g-acc" });
  expect(server.seen.find((s) => s.path === "/oauth2/token")).toBeTruthy();
});

test("pasting a URL from another sign-in, or with no attempt, is refused in plain words", async () => {
  server = tokenServer();
  const { auth } = setup();
  await expect(auth.finishSignIn("codex", "abc")).rejects.toThrow("Start again");
  await auth.startSignIn("codex");
  await expect(auth.finishSignIn("codex", "http://localhost:1455/auth/callback?code=x&state=other")).rejects.toThrow("different sign-in");
  await expect(auth.finishSignIn("codex", "http://localhost:1455/auth/callback?error=access_denied")).rejects.toThrow("declined");
});

test("tokens refresh shortly before they expire; concurrent callers share one refresh", async () => {
  server = tokenServer([
    { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 },
    { access_token: "acc-2", expires_in: 3600 },
  ]);
  let clock = Date.now(); // shared-ai-auth stamps expiry with the real clock
  const { keychain, auth } = setup({ now: () => clock });
  await auth.startSignIn("grok");
  await auth.finishSignIn("grok", "code");
  clock += 3600_000;
  const [a, b] = await Promise.all([auth.tokens("grok"), auth.tokens("grok")]);
  expect(a.accessToken).toBe("acc-2");
  expect(b.accessToken).toBe("acc-2");
  expect(server.seen.filter((s) => s.path === "/oauth2/token")).toHaveLength(2);
  // The refresh token was not rotated, so the old one is kept.
  expect(JSON.parse((await keychain.get("oauth:grok"))!).refreshToken).toBe("ref-1");
});

test("a rejected refresh marks the sign-in expired; sign-out removes it", async () => {
  server = tokenServer([{ access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 }, { status: 400, error: "invalid_grant" }]);
  let clock = Date.now();
  const { keychain, auth } = setup({ now: () => clock });
  await auth.startSignIn("grok");
  await auth.finishSignIn("grok", "code");
  clock += 7200_000;
  await expect(auth.tokens("grok")).rejects.toThrow("Sign in to Grok again");
  expect(await auth.status("grok")).toBe("expired");
  await auth.signOut("grok");
  expect(await keychain.get("oauth:grok")).toBeNull();
  expect(await auth.status("grok")).toBe("signed-out");
  await expect(auth.tokens("grok")).rejects.toThrow("Sign in to Grok");
});

test("signing out while a refresh is in flight keeps the user signed out", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  server = fakeServer(async () => {
    if (n++ === 0) return json({ access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 });
    await gate;
    return json({ access_token: "acc-2", refresh_token: "ref-2", expires_in: 3600 });
  });
  let clock = Date.now();
  const { keychain, auth } = setup({ now: () => clock });
  await auth.startSignIn("grok");
  await auth.finishSignIn("grok", "code");
  clock += 7200_000;
  const refreshing = auth.tokens("grok").catch((e: Error) => e);
  await Bun.sleep(20);
  await auth.signOut("grok");
  release();
  expect(String(await refreshing)).toContain("Signed out of Grok");
  expect(await keychain.get("oauth:grok")).toBeNull();
  expect(await auth.status("grok")).toBe("signed-out");
});

test("unreadable stored tokens count as signed out", async () => {
  server = tokenServer();
  const { keychain, auth } = setup();
  await keychain.set("oauth:codex", "{not json");
  expect(await auth.status("codex")).toBe("signed-out");
});
