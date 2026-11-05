import { describe, expect, it } from "vitest";
import { codeFrom, device, freshEmail, harness, linkTokenFrom, signIn } from "./helpers";

async function start(h: ReturnType<typeof harness>, email = freshEmail()) {
  const dev = await device("Work Mac");
  const res = await h.call("POST", "/v1/auth/email/start", { body: { email, device: dev } });
  expect(res.status).toBe(200);
  return { ...res.data, mail: h.mailer.sent.at(-1)!, email };
}

describe("email sign-in", () => {
  it("sends a link and a code, and keeps the token out of the URL path", async () => {
    const h = harness();
    const s = await start(h, "Person@Example.com ");
    expect(s.mail.to).toBe("person@example.com");
    expect(s.mail.subject).toBe("Sign in to Perch");
    expect(s.mail.text).toContain("https://api.perchbrowser.com/v1/auth/email/confirm#elk_");
    expect(codeFrom(s.mail.text)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(s.matchNumber).toBeGreaterThanOrEqual(10);
    expect(s.matchNumber).toBeLessThanOrEqual(99);
  });

  it("signs in with the code, creating the account once", async () => {
    const h = harness();
    const email = freshEmail();
    const first = await start(h, email);
    const res = await h.call("POST", "/v1/auth/email/verify", {
      body: { requestId: first.requestId, pollSecret: first.pollSecret, code: codeFrom(first.mail.text).toLowerCase().replace("-", " ") },
    });
    expect(res.status).toBe(200);
    expect(res.data.newAccount).toBe(true);
    expect(res.data.sessionToken).toMatch(/^pst_/);
    const again = await signIn(h, email);
    expect(again.accountId).toBe(res.data.accountId);
    expect(again.deviceId).not.toBe(res.data.deviceId);
    const me = await h.call("GET", "/v1/account", { token: again.sessionToken });
    expect(me.data.email).toBe(email);
  });

  it("signs in by link only after the right number is picked, and only the asking device gets the session", async () => {
    const h = harness();
    const s = await start(h);
    const token = linkTokenFrom(s.mail.text);
    expect((await h.call("POST", "/v1/auth/email/poll", { body: { requestId: s.requestId, pollSecret: s.pollSecret } })).data.status).toBe("pending");
    const info = await h.call("POST", "/v1/auth/email/confirm/info", { body: { token } });
    expect(info.data.deviceName).toBe("Work Mac");
    expect(info.data.choices).toHaveLength(3);
    expect(info.data.choices).toContain(s.matchNumber);
    const confirmed = await h.call("POST", "/v1/auth/email/confirm", { body: { token, match: s.matchNumber } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.data).toEqual({ deviceName: "Work Mac" });
    const polled = await h.call("POST", "/v1/auth/email/poll", { body: { requestId: s.requestId, pollSecret: s.pollSecret } });
    expect(polled.data.status).toBe("signed_in");
    expect(polled.data.sessionToken).toMatch(/^pst_/);
    // The session is handed out once.
    expect((await h.call("POST", "/v1/auth/email/poll", { body: { requestId: s.requestId, pollSecret: s.pollSecret } })).status).toBe(410);
  });

  it("cancels the request when the wrong number is picked", async () => {
    const h = harness();
    const s = await start(h);
    const token = linkTokenFrom(s.mail.text);
    const wrong = s.matchNumber === 99 ? 98 : s.matchNumber + 1;
    expect((await h.call("POST", "/v1/auth/email/confirm", { body: { token, match: wrong } })).status).toBe(400);
    expect((await h.call("POST", "/v1/auth/email/confirm", { body: { token, match: s.matchNumber } })).status).toBe(410);
    expect((await h.call("POST", "/v1/auth/email/poll", { body: { requestId: s.requestId, pollSecret: s.pollSecret } })).status).toBe(410);
  });

  it("does nothing on a plain GET of the link, so mail scanners cannot use it up", async () => {
    const h = harness();
    const s = await start(h);
    const page = await h.call("GET", "/v1/auth/email/confirm");
    expect(page.status).toBe(200);
    expect(page.res.headers.get("content-type")).toContain("text/html");
    expect(page.res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-n_[A-Za-z0-9_-]+'/);
    expect(page.data).toContain("Sign in to Perch");
    const info = await h.call("POST", "/v1/auth/email/confirm/info", { body: { token: linkTokenFrom(s.mail.text) } });
    expect(info.status).toBe(200);
  });

  it("needs the poll secret, not just the request id", async () => {
    const h = harness();
    const s = await start(h);
    const res = await h.call("POST", "/v1/auth/email/verify", {
      body: { requestId: s.requestId, pollSecret: `eps_${"A".repeat(43)}`, code: codeFrom(s.mail.text) },
    });
    expect(res.status).toBe(404);
  });

  it("cancels after five wrong codes", async () => {
    const h = harness();
    const s = await start(h);
    const body = { requestId: s.requestId, pollSecret: s.pollSecret, code: "0000-0000" };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await h.call("POST", "/v1/auth/email/verify", { body })).data.error.code);
    expect(statuses).toEqual(["wrong_code", "wrong_code", "wrong_code", "wrong_code", "too_many_attempts"]);
    const right = await h.call("POST", "/v1/auth/email/verify", { body: { ...body, code: codeFrom(s.mail.text) } });
    expect(right.status).toBe(410);
  });

  it("expires after 15 minutes", async () => {
    const h = harness();
    const s = await start(h);
    h.clock.now += 15 * 60 * 1000 + 1;
    const res = await h.call("POST", "/v1/auth/email/verify", { body: { requestId: s.requestId, pollSecret: s.pollSecret, code: codeFrom(s.mail.text) } });
    expect(res.status).toBe(410);
  });

  it("answers the same for new and known addresses", async () => {
    const h = harness();
    const known = freshEmail();
    await signIn(h, known);
    const a = await h.call("POST", "/v1/auth/email/start", { body: { email: known, device: await device() } });
    const b = await h.call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), device: await device() } });
    expect(Object.keys(a.data).sort()).toEqual(Object.keys(b.data).sort());
    expect(h.mailer.sent.at(-2)!.subject).toBe(h.mailer.sent.at(-1)!.subject);
  });

  it("limits sign-in emails per address across IPs", async () => {
    const h = harness();
    const email = freshEmail();
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await h.call("POST", "/v1/auth/email/start", { body: { email, device: await device() }, ip: `192.0.2.${i + 1}` })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("escapes the device name in the HTML email", async () => {
    const h = harness();
    const res = await h.call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), device: { ...(await device()), name: "Bob's Mac (old)" } } });
    expect(res.status).toBe(200);
    expect(h.mailer.sent.at(-1)!.html).toContain("Bob&#39;s Mac (old)");
    const bad = await h.call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), device: { ...(await device()), name: "<b>x</b>" } } });
    expect(bad.status).toBe(400);
  });

  it("rejects bearer tokens it does not know", async () => {
    const h = harness();
    const res = await h.call("GET", "/v1/account", { token: `pst_${"A".repeat(43)}` });
    expect(res.status).toBe(401);
    expect(res.res.headers.get("www-authenticate")).toBe("Bearer");
  });
});
