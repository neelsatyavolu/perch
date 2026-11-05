import { describe, expect, it } from "vitest";
import { appEnv, device, freshEmail, harness, signIn, type Harness, type Session } from "./helpers";
import { SoftPasskey } from "./webauthn";
import { toBase64Url } from "../src/crypto";

async function register(h: Harness, s: Session, key: SoftPasskey, origin?: string) {
  const options = await h.call("POST", "/v1/auth/passkey/register/options", { token: s.sessionToken, body: {} });
  expect(options.status).toBe(200);
  expect(options.data.options.rp.id).toBe("perchbrowser.com");
  return h.call("POST", "/v1/auth/passkey/register/verify", {
    token: s.sessionToken,
    body: { challengeId: options.data.challengeId, response: await key.register(options.data.options.challenge, origin) },
  });
}

async function login(h: Harness, key: SoftPasskey, accountId: string, origin?: string) {
  const options = await h.call("POST", "/v1/auth/passkey/login/options", { body: {} });
  expect(options.data.options.userVerification).toBe("required");
  const response = await key.authenticate(options.data.options.challenge, toBase64Url(new TextEncoder().encode(accountId)), origin);
  return h.call("POST", "/v1/auth/passkey/login/verify", { body: { challengeId: options.data.challengeId, response, device: await device("New Mac") } });
}

describe("passkeys", () => {
  it("registers a passkey and signs a new device in with it", async () => {
    const h = harness();
    const s = await signIn(h);
    const key = await SoftPasskey.create();
    const registered = await register(h, s, key);
    expect(registered.status).toBe(200);
    expect(registered.data.passkeyId).toBe(key.id);
    const signedIn = await login(h, key, s.accountId);
    expect(signedIn.status).toBe(200);
    expect(signedIn.data).toMatchObject({ status: "signed_in", accountId: s.accountId });
    expect(signedIn.data.deviceId).not.toBe(s.deviceId);
    const listed = await h.call("GET", "/v1/auth/passkey", { token: signedIn.data.sessionToken });
    expect(listed.data.passkeys[0].lastUsedAt).toBe(h.clock.now);
  });

  it("refuses a passkey made for another origin", async () => {
    const h = harness();
    const s = await signIn(h);
    const key = await SoftPasskey.create("perchbrowser.com", "https://evil.example");
    expect((await register(h, s, key)).status).toBe(400);
  });

  it("refuses a replayed challenge and an unknown credential", async () => {
    const h = harness();
    const s = await signIn(h);
    const key = await SoftPasskey.create();
    await register(h, s, key);
    const options = await h.call("POST", "/v1/auth/passkey/login/options", { body: {} });
    const response = await key.authenticate(options.data.options.challenge, "x");
    const body = { challengeId: options.data.challengeId, response, device: await device() };
    expect((await h.call("POST", "/v1/auth/passkey/login/verify", { body })).status).toBe(200);
    expect((await h.call("POST", "/v1/auth/passkey/login/verify", { body })).status).toBe(400);
    const stranger = await SoftPasskey.create();
    expect((await login(h, stranger, s.accountId)).status).toBe(400);
  });

  it("deletes a passkey so it no longer signs in", async () => {
    const h = harness();
    const s = await signIn(h);
    const key = await SoftPasskey.create();
    await register(h, s, key);
    expect((await h.call("DELETE", `/v1/auth/passkey/${key.id}`, { token: s.sessionToken })).status).toBe(200);
    expect((await login(h, key, s.accountId)).status).toBe(400);
  });
});

describe("account", () => {
  it("deletes everything the account holds", async () => {
    const h = harness();
    const email = freshEmail();
    const s = await signIn(h, email);
    await h.call("POST", "/v1/keys/rotate", { token: s.sessionToken, body: { version: 1, devices: { [s.deviceId]: `w${"A".repeat(30)}` } } });
    const big = toBase64Url(new Uint8Array(70_000).fill(3));
    await h.call("POST", "/v1/sync/memory/commit", { token: s.sessionToken, body: { items: [{ id: `m${"1".repeat(21)}`, baseVersion: 0, keyVersion: 1, ciphertext: big }] } });
    expect((await appEnv.BLOBS.list({ prefix: `items/${s.accountId}/` })).objects).toHaveLength(1);

    expect((await h.call("DELETE", "/v1/account", { token: s.sessionToken, body: { confirm: "yes" } })).status).toBe(400);
    expect((await h.call("DELETE", "/v1/account", { token: s.sessionToken, body: { confirm: "delete my account" } })).status).toBe(200);
    expect((await h.call("GET", "/v1/account", { token: s.sessionToken })).status).toBe(401);
    expect((await appEnv.BLOBS.list({ prefix: `items/${s.accountId}/` })).objects).toHaveLength(0);
    for (const table of ["items", "devices", "sessions", "wrapped_keys"]) {
      const row = await appEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).bind(s.accountId).first<{ n: number }>();
      expect(row?.n).toBe(0);
    }
    // Signing in again with the same email starts a new, empty account.
    const again = await signIn(h, email);
    expect(again.accountId).not.toBe(s.accountId);
  });
});
