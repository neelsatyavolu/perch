import { describe, expect, it } from "vitest";
import { device, harness, signIn, type Harness } from "./helpers";
import { fromBase64Url, pairingCode, sha256, base32, formatCode } from "../src/crypto";

async function startPairing(h: Harness, name = "Grok Bot computer", kind = "cli") {
  const dev = await device(name, kind);
  const res = await h.call("POST", "/v1/pair/start", { body: dev });
  expect(res.status).toBe(200);
  return { ...res.data, publicKey: dev.publicKey };
}

describe("pairing", () => {
  it("derives the code from the new device's public key", async () => {
    const h = harness();
    const p = await startPairing(h);
    expect(p.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(p.code).toBe(formatCode(base32(await sha256(fromBase64Url(p.publicKey)), 8)));
    expect(await pairingCode(p.publicKey)).toBe(p.code);
  });

  it("pairs: lookup by code, approve with a wrapped key, poll once for the session and peers", async () => {
    const h = harness();
    const mac = await signIn(h);
    await h.call("POST", "/v1/keys/rotate", { token: mac.sessionToken, body: { version: 1, devices: { [mac.deviceId]: `w${"A".repeat(30)}` } } });
    const p = await startPairing(h);
    expect((await h.call("POST", "/v1/pair/poll", { body: { pairingId: p.pairingId, pollSecret: p.pollSecret } })).data).toEqual({ status: "pending" });

    const lookup = await h.call("GET", `/v1/pair/lookup?code=${p.code.toLowerCase().replace("-", "")}`, { token: mac.sessionToken });
    expect(lookup.data).toMatchObject({ pairingId: p.pairingId, publicKey: p.publicKey, name: "Grok Bot computer", kind: "cli" });
    const approved = await h.call("POST", `/v1/pair/${p.pairingId}/approve`, { token: mac.sessionToken, body: {} });
    expect(approved.status).toBe(200);
    const granted = await h.call("PUT", `/v1/keys/devices/${approved.data.deviceId}`, { token: mac.sessionToken, body: { version: 1, blob: `w${"C".repeat(30)}` } });
    expect(granted.status).toBe(200);

    const polled = await h.call("POST", "/v1/pair/poll", { body: { pairingId: p.pairingId, pollSecret: p.pollSecret } });
    expect(polled.data).toMatchObject({ status: "approved", accountId: mac.accountId, deviceId: approved.data.deviceId, approverDeviceId: mac.deviceId });
    expect(polled.data.peers.map((d: any) => d.id)).toEqual([mac.deviceId]);
    const keys = await h.call("GET", "/v1/keys", { token: polled.data.sessionToken });
    expect(keys.data.device).toEqual({ version: 1, blob: `w${"C".repeat(30)}` });
    expect((await h.call("POST", "/v1/pair/poll", { body: { pairingId: p.pairingId, pollSecret: p.pollSecret } })).status).toBe(410);
  });

  it("denied and expired pairings cannot be approved or polled", async () => {
    const h = harness();
    const mac = await signIn(h);
    const denied = await startPairing(h);
    expect((await h.call("POST", `/v1/pair/${denied.pairingId}/deny`, { token: mac.sessionToken, body: {} })).status).toBe(200);
    expect((await h.call("POST", `/v1/pair/${denied.pairingId}/approve`, { token: mac.sessionToken, body: {} })).status).toBe(410);
    expect((await h.call("POST", "/v1/pair/poll", { body: { pairingId: denied.pairingId, pollSecret: denied.pollSecret } })).status).toBe(410);

    const late = await startPairing(h);
    h.clock.now += 10 * 60 * 1000 + 1;
    expect((await h.call("GET", `/v1/pair/lookup?code=${late.code}`, { token: mac.sessionToken })).status).toBe(404);
    expect((await h.call("POST", `/v1/pair/${late.pairingId}/approve`, { token: mac.sessionToken, body: {} })).status).toBe(410);
  });

  it("needs a signed-in device to look up or approve", async () => {
    const h = harness();
    const p = await startPairing(h);
    expect((await h.call("GET", `/v1/pair/lookup?code=${p.code}`)).status).toBe(401);
    expect((await h.call("POST", `/v1/pair/${p.pairingId}/approve`, { body: {} })).status).toBe(401);
  });

  it("limits code lookups per account, so codes cannot be guessed", async () => {
    const h = harness();
    const mac = await signIn(h);
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await h.call("GET", `/v1/pair/lookup?code=ZZZZ-ZZ${String(i).padStart(2, "0")}`, { token: mac.sessionToken })).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("needs the poll secret", async () => {
    const h = harness();
    const p = await startPairing(h);
    expect((await h.call("POST", "/v1/pair/poll", { body: { pairingId: p.pairingId, pollSecret: `pps_${"A".repeat(43)}` } })).status).toBe(404);
  });
});
