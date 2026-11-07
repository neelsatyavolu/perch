import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { verifyIdToken } from "../src/auth/jwt";
import { device, freshEmail, harness } from "./helpers";
import { fakeIdp, type Tamper } from "./fake-idp";
import { ADMIN_GROUP, begin, callback, company, poll, signInOidc, typeNumber, user } from "./oidc-flow";

describe("OpenID Connect sign-in", () => {
  it("signs a device in through the identity provider and hands the session to that device once", async () => {
    const { h, idp } = await company();
    const start = await begin(h);
    expect(start.url).toBe(`https://api.perchbrowser.com/v1/auth/oidc/go?r=${start.requestId}`);
    expect(start.matchNumber).toBeGreaterThanOrEqual(10);
    expect(start.matchNumber).toBeLessThanOrEqual(99);
    expect((await poll(h, start)).data).toEqual({ status: "pending" });

    const page = await h.call("GET", `/v1/auth/oidc/go?r=${start.requestId}`);
    expect(page.status).toBe(200);
    expect(page.res.headers.get("content-type")).toContain("text/html");
    expect(page.res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-n_[A-Za-z0-9_-]+'/);
    const info = await h.call("POST", "/v1/auth/oidc/go/info", { body: { requestId: start.requestId } });
    expect(info.data).toEqual({ deviceName: "Work Mac" });

    const go = await typeNumber(h, start);
    expect(go.status).toBe(200);
    const auth = new URL(go.url);
    expect(`${auth.origin}${auth.pathname}`).toBe(`${idp.issuer}/authorize`);
    expect(auth.searchParams.get("redirect_uri")).toBe("https://api.perchbrowser.com/v1/auth/oidc/callback");
    expect(auth.searchParams.get("scope")).toBe("openid email profile groups");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(go.res.headers.get("set-cookie")).toMatch(/^__Host-perch-oidc=obd_[A-Za-z0-9_-]{43}; .*HttpOnly/);
    expect(go.res.headers.get("set-cookie")).toMatch(/Secure/);
    expect((await poll(h, start)).data).toEqual({ status: "pending" });

    const who = user();
    const back = await callback(h, idp.authorize(go.url, who), go.cookie);
    expect(back.status).toBe(200);
    expect(back.data).toContain("Perch is signed in. You can close this tab.");
    expect(back.res.headers.get("set-cookie")).toMatch(/^__Host-perch-oidc=; .*Max-Age=0/);
    // PKCE: the token request carried the verifier, and the client secret went in the Basic header.
    expect(idp.tokenRequests.at(-1)!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(idp.tokenRequests.at(-1)!.has("client_secret")).toBe(false);

    const polled = await poll(h, start);
    expect(polled.status).toBe(200);
    expect(polled.data).toMatchObject({ status: "signed_in", admin: false });
    expect(polled.data.sessionToken).toMatch(/^pst_/);
    const me = await h.call("GET", "/v1/account", { token: polled.data.sessionToken });
    expect(me.status).toBe(200);
    expect(me.data.email).toBe(who.email);
    expect((await poll(h, start)).status).toBe(410);

    // Only hashes of the poll secret and state are kept, and nothing of the exchange outlives it.
    const row = await h.env.DB.prepare("SELECT * FROM oidc_requests WHERE id = ?").bind(start.requestId).first<Record<string, unknown>>();
    expect(row!.poll_hash).toBe(await sha256Hex(start.pollSecret));
    expect(JSON.stringify(row)).not.toContain(auth.searchParams.get("state")!);
    expect(row!.nonce).toBeNull();
    expect(row!.verifier).toBeNull();
  });

  it("refuses an ID token with the wrong nonce, audience, issuer, signature, or an expired one", async () => {
    const { h, idp } = await company();
    const now = () => Math.floor(h.clock.now / 1000);
    const spoiled: Tamper[] = [
      { claims: { nonce: "onc_someone-elses-nonce" } },
      { claims: { aud: "another-app" } },
      { claims: { aud: [idp.clientId, "another-app"] } },
      { claims: { iss: "https://evil.example.com" } },
      { signWith: "stranger" },
      { claims: { exp: now() - 61 } },
      { claims: { iat: now() + 3600 } },
      { header: { alg: "none" } },
      { header: { alg: "HS256" } },
    ];
    for (const tamper of spoiled) {
      const { back, polled } = await signInOidc(h, idp, user(), { tamper });
      expect(back.status, JSON.stringify(tamper)).toBe(400);
      expect(back.data).not.toContain("Perch is signed in");
      expect(polled.status, JSON.stringify(tamper)).toBe(410);
    }
    // Within the 60-second skew is fine.
    const { back, polled } = await signInOidc(h, idp, user(), { tamper: { claims: { exp: now() - 30 } } });
    expect(back.status).toBe(200);
    expect(polled.data.status).toBe("signed_in");
  });

  it("refuses a reused state and a callback for a request that is not waiting", async () => {
    const { h, idp } = await company();
    const start = await begin(h);
    const go = await typeNumber(h, start);
    const path = idp.authorize(go.url, user());
    expect((await callback(h, path, go.cookie)).status).toBe(200);
    expect((await callback(h, path, go.cookie)).status).toBe(400);

    // A state nobody was given.
    expect((await callback(h, `/v1/auth/oidc/callback?code=abc&state=ost_${"A".repeat(43)}`, go.cookie)).status).toBe(400);
    expect((await callback(h, "/v1/auth/oidc/callback?code=abc")).status).toBe(400);

    // A request that never passed the number page has no state to call back with.
    const waiting = await begin(h);
    expect((await poll(h, waiting)).data.status).toBe("pending");

    // An expired request.
    const late = await begin(h);
    const lateGo = await typeNumber(h, late);
    h.clock.now += 15 * 60 * 1000 + 1;
    expect((await callback(h, idp.authorize(lateGo.url, user()), lateGo.cookie)).status).toBe(400);
    expect((await poll(h, late)).status).toBe(410);

    // The provider says no.
    const refused = await begin(h);
    const refusedGo = await typeNumber(h, refused);
    const state = new URL(refusedGo.url).searchParams.get("state")!;
    const answer = await callback(h, `/v1/auth/oidc/callback?error=access_denied&state=${state}`, refusedGo.cookie);
    expect(answer.status).toBe(400);
    expect((await poll(h, refused)).status).toBe(410);
  });

  it("cancels the request when the wrong number is typed, so a forwarded link cannot sign the sender in", async () => {
    const { h, idp } = await company();
    const start = await begin(h);
    const wrong = start.matchNumber === 99 ? 98 : start.matchNumber + 1;
    const typed = await typeNumber(h, start, wrong);
    expect(typed.status).toBe(400);
    expect(typed.data.error.code).toBe("wrong_number");
    expect((await typeNumber(h, start)).status).toBe(410);
    expect((await h.call("POST", "/v1/auth/oidc/go/info", { body: { requestId: start.requestId } })).status).toBe(410);
    expect((await poll(h, start)).status).toBe(410);

    // The sender passes the number page on their own machine and forwards the provider's URL. The
    // person who opens it has no cookie from that page, so the callback cancels the request.
    const sender = await begin(h);
    const senderGo = await typeNumber(h, sender);
    const victimBack = await callback(h, idp.authorize(senderGo.url, user("victim")));
    expect(victimBack.status).toBe(400);
    expect((await poll(h, sender)).status).toBe(410);
  });

  it("refetches the JWKS once when the key id is new, and refuses an unknown key after that", async () => {
    const { h, idp } = await company();
    expect((await signInOidc(h, idp, user())).polled.data.status).toBe("signed_in");
    expect(idp.counts.jwks).toBe(1);
    expect((await signInOidc(h, idp, user())).polled.data.status).toBe("signed_in");
    expect(idp.counts.jwks).toBe(1);
    expect(idp.counts.discovery).toBe(1);

    await idp.rotate();
    expect((await signInOidc(h, idp, user())).polled.data.status).toBe("signed_in");
    expect(idp.counts.jwks).toBe(2);

    const unknown = await signInOidc(h, idp, user(), { tamper: { header: { kid: "nobody-knows" }, signWith: "stranger" } });
    expect(unknown.back.status).toBe(400);
    expect(unknown.polled.status).toBe(410);
    expect(idp.counts.jwks).toBe(3);

    // Discovery and keys are cached for an hour.
    h.clock.now += 60 * 60 * 1000 + 1;
    expect((await signInOidc(h, idp, user())).polled.data.status).toBe("signed_in");
    expect(idp.counts.discovery).toBe(2);
    expect(idp.counts.jwks).toBe(4);
  });

  it("marks the session admin only when the verified token has the admin group", async () => {
    const { h, idp } = await company();
    const admin = await signInOidc(h, idp, { ...user("admin"), groups: ["staff", ADMIN_GROUP] });
    expect(admin.polled.data.admin).toBe(true);
    expect((await h.call("GET", "/v1/admin/devices", { token: admin.polled.data.sessionToken })).status).toBe(200);

    const staff = await signInOidc(h, idp, { ...user("staff"), groups: ["staff"] });
    expect(staff.polled.data.admin).toBe(false);
    expect((await h.call("GET", "/v1/admin/devices", { token: staff.polled.data.sessionToken })).status).toBe(403);

    const loose = await signInOidc(h, idp, { ...user("loose"), groups: `${ADMIN_GROUP}` as unknown as string[] });
    expect(loose.polled.data.admin).toBe(false);

    const forged = await signInOidc(h, idp, { ...user("forged"), groups: [ADMIN_GROUP] }, { tamper: { signWith: "stranger" } });
    expect(forged.back.status).toBe(400);
    expect(forged.polled.status).toBe(410);
  });

  it("turns email and passkey sign-up off in company mode and keeps them in public mode", async () => {
    const { h } = await company();
    const dev = await device();
    expect((await h.call("GET", "/v1/server")).data).toEqual({ auth: ["oidc"], name: "Perch" });
    expect((await h.call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), device: dev } })).status).toBe(404);
    expect((await h.call("GET", "/v1/auth/email/confirm")).status).toBe(404);
    expect((await h.call("POST", "/v1/auth/passkey/register/options", { body: {} })).status).toBe(404);
    expect((await h.call("POST", "/v1/auth/passkey/login/options", { body: {} })).status).toBe(404);
    // Pairing starts from a signed-in device, so it stays.
    expect((await h.call("POST", "/v1/pair/start", { body: { ...dev, code: "ABCD-EFGH" } })).status).not.toBe(404);

    const pub = harness();
    expect((await pub.call("GET", "/v1/server")).data).toEqual({ auth: ["email", "passkey"], name: "Perch" });
    expect((await pub.call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), device: dev } })).status).toBe(200);
    expect((await pub.call("POST", "/v1/auth/passkey/login/options", { body: {} })).status).toBe(200);
    expect((await pub.call("POST", "/v1/auth/oidc/start", { body: { device: dev } })).status).toBe(404);
    expect((await pub.call("GET", "/v1/auth/oidc/go?r=x")).status).toBe(404);

    const unknownMode = harness(Date.now(), { env: { AUTH_MODE: "compnay" as "company" } });
    expect((await unknownMode.call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), device: dev } })).status).toBe(500);
  });

  it("keeps the same account when the user's email changes at the provider", async () => {
    const { h, idp } = await company();
    const who = user("renamed");
    const first = await signInOidc(h, idp, who);
    expect(first.polled.data.status).toBe("signed_in");
    const newEmail = freshEmail("renamed-new");
    const second = await signInOidc(h, idp, { ...who, email: newEmail });
    expect(second.polled.data.accountId).toBe(first.polled.data.accountId);
    const me = await h.call("GET", "/v1/account", { token: second.polled.data.sessionToken });
    expect(me.data.email).toBe(newEmail);

    // Email is display only: another subject with the old address gets its own account.
    const other = await signInOidc(h, idp, { sub: `sub-other-${crypto.randomUUID()}`, email: who.email });
    expect(other.polled.data.accountId).not.toBe(first.polled.data.accountId);
    // And a subject with no email at all still signs in.
    const bare = await signInOidc(h, idp, { sub: `sub-bare-${crypto.randomUUID()}` });
    expect(bare.polled.data.status).toBe("signed_in");
  });

  it("asks for the groups scope only when the provider lists it", async () => {
    const { h } = await company({ scopes: ["openid", "email", "profile"] });
    const go = await typeNumber(h, await begin(h));
    expect(new URL(go.url).searchParams.get("scope")).toBe("openid email profile");
  });

  it("accepts ES256 ID tokens", async () => {
    const { h, idp } = await company({ alg: "ES256" });
    const { back, polled } = await signInOidc(h, idp, user());
    expect(back.status).toBe(200);
    expect(polled.data.status).toBe("signed_in");
  });
});

describe("verifyIdToken", () => {
  it("checks the token against the keys, issuer, audience, nonce and clock", async () => {
    const clock = { now: Date.now() };
    const idp = await fakeIdp({ now: () => clock.now });
    const keys = (await (await idp.fetch(`${idp.issuer}/jwks`)).json()) as { keys: JsonWebKey[] };
    const iat = Math.floor(clock.now / 1000);
    const token = await idp.sign({ iss: idp.issuer, aud: idp.clientId, sub: "s1", nonce: "n1", iat, exp: iat + 60 });
    const options = { issuer: idp.issuer, audience: idp.clientId, nonce: "n1", jwks: async () => keys.keys, now: clock.now };
    expect((await verifyIdToken(token, options)).sub).toBe("s1");
    await expect(verifyIdToken(token, { ...options, nonce: "n2" })).rejects.toMatchObject({ reason: "bad_nonce" });
    await expect(verifyIdToken(token, { ...options, now: clock.now + 121_000 })).rejects.toMatchObject({ reason: "expired" });
    await expect(verifyIdToken(`${token}x`, options)).rejects.toMatchObject({ reason: "bad_signature" });
    await expect(verifyIdToken("a.b", options)).rejects.toMatchObject({ reason: "malformed" });
  });
});
