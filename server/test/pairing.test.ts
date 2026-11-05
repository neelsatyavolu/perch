import { describe, expect, it } from "vitest";
import { appEnv, device, harness, signIn, type Harness } from "./helpers";
import { randomCode } from "../src/crypto";

const GRANT = `g${"G".repeat(40)}`;

async function startPairing(h: Harness, name = "Grok Bot computer", kind = "cli", code = randomCode()) {
  const dev = await device(name, kind);
  const res = await h.call("POST", "/v1/pair/start", { body: { ...dev, code } });
  expect(res.status).toBe(200);
  return { ...res.data, publicKey: dev.publicKey };
}

const approve = (h: Harness, token: string | undefined, pairingId: string, grant: string = GRANT) =>
  h.call("POST", `/v1/pair/${pairingId}/approve`, { token, body: { grant } });
const poll = (h: Harness, p: { pairingId: string; pollSecret: string }) =>
  h.call("POST", "/v1/pair/poll", { body: { pairingId: p.pairingId, pollSecret: p.pollSecret } });
const deviceCount = async (accountId: string) =>
  (await appEnv.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?").bind(accountId).first<number>("n")) ?? 0;

describe("pairing", () => {
  it("keeps the code the device sent (the server cannot derive it) and finds the request by it", async () => {
    const h = harness();
    const mac = await signIn(h);
    const p = await startPairing(h, "New MacBook", "browser", "ABCD-EFGH");
    expect(p.code).toBe("ABCD-EFGH");
    const lookup = await h.call("GET", "/v1/pair/lookup?code=abcdefgh", { token: mac.sessionToken });
    expect(lookup.data).toMatchObject({ pairingId: p.pairingId, publicKey: p.publicKey });
    const bad = await h.call("POST", "/v1/pair/start", { body: { ...(await device()), code: "ABCD-EFGI" } });
    expect(bad.status).toBe(400);
  });

  it("pairs a new Mac: lookup by code, approve, grant the key, poll once for the session and peers", async () => {
    const h = harness();
    const mac = await signIn(h);
    await h.call("POST", "/v1/keys/rotate", { token: mac.sessionToken, body: { version: 1, devices: { [mac.deviceId]: `w${"A".repeat(30)}` } } });
    const p = await startPairing(h, "New MacBook", "browser");
    expect((await h.call("POST", "/v1/pair/poll", { body: { pairingId: p.pairingId, pollSecret: p.pollSecret } })).data).toEqual({ status: "pending" });

    const lookup = await h.call("GET", `/v1/pair/lookup?code=${p.code.toLowerCase().replace("-", "")}`, { token: mac.sessionToken });
    expect(lookup.data).toMatchObject({ pairingId: p.pairingId, publicKey: p.publicKey, name: "New MacBook", kind: "browser" });
    expect((await h.call("POST", `/v1/pair/${p.pairingId}/approve`, { token: mac.sessionToken, body: {} })).status).toBe(400);
    const approved = await approve(h, mac.sessionToken, p.pairingId);
    expect(approved.status).toBe(200);
    // The device and the claim land together: the very next poll has the session.
    const polled = await poll(h, p);
    expect(polled.data).toMatchObject({ status: "approved", accountId: mac.accountId, deviceId: approved.data.deviceId, approverDeviceId: mac.deviceId, grant: GRANT });
    expect(polled.data.peers.map((d: any) => d.id)).toEqual([mac.deviceId]);
    // The new device writes its own key copy from the grant.
    const granted = await h.call("PUT", `/v1/keys/devices/${approved.data.deviceId}`, { token: polled.data.sessionToken, body: { version: 1, blob: `w${"C".repeat(30)}` } });
    expect(granted.status).toBe(200);
    expect((await poll(h, p)).status).toBe(410);
    const row = await appEnv.DB.prepare("SELECT grant_blob FROM pairings WHERE id = ?").bind(p.pairingId).first<{ grant_blob: string | null }>();
    expect(row?.grant_blob).toBeNull();
  });

  it("denied and expired pairings cannot be approved or polled", async () => {
    const h = harness();
    const mac = await signIn(h);
    const denied = await startPairing(h);
    expect((await h.call("POST", `/v1/pair/${denied.pairingId}/deny`, { token: mac.sessionToken, body: {} })).status).toBe(200);
    expect((await approve(h, mac.sessionToken, denied.pairingId)).status).toBe(410);
    expect((await poll(h, denied)).status).toBe(410);

    const late = await startPairing(h);
    h.clock.now += 10 * 60 * 1000 + 1;
    expect((await h.call("GET", `/v1/pair/lookup?code=${late.code}`, { token: mac.sessionToken })).status).toBe(404);
    expect((await approve(h, mac.sessionToken, late.pairingId)).status).toBe(410);
    // A refused approval adds no device.
    expect(await deviceCount(mac.accountId)).toBe(1);
  });

  it("lets a device start again with the same code after a deny or once a request is used", async () => {
    const h = harness();
    const mac = await signIn(h);
    const first = await startPairing(h, "Grok Bot computer", "cli", "QRST-VWXY");
    await h.call("POST", `/v1/pair/${first.pairingId}/deny`, { token: mac.sessionToken, body: {} });
    const again = await startPairing(h, "Grok Bot computer", "cli", "QRST-VWXY");
    await approve(h, mac.sessionToken, again.pairingId);
    expect((await poll(h, again)).status).toBe(200);
    const third = await startPairing(h, "Grok Bot computer", "cli", "QRST-VWXY");
    expect(third.pairingId).not.toBe(again.pairingId);
  });

  it("never lets a second device take over a request that is still waiting", async () => {
    const h = harness();
    const mac = await signIn(h);
    const victim = await startPairing(h, "New MacBook", "browser", "MNPQ-RSTV");
    const attacker = await h.call("POST", "/v1/pair/start", { body: { ...(await device("New MacBook", "browser")), code: "MNPQ-RSTV" } });
    expect(attacker.status).toBe(409);
    expect(attacker.data.error.code).toBe("code_in_use");
    const lookup = await h.call("GET", "/v1/pair/lookup?code=MNPQ-RSTV", { token: mac.sessionToken });
    expect(lookup.data).toMatchObject({ pairingId: victim.pairingId, publicKey: victim.publicKey });
  });

  it("needs a signed-in device to look up or approve", async () => {
    const h = harness();
    const p = await startPairing(h);
    expect((await h.call("GET", `/v1/pair/lookup?code=${p.code}`)).status).toBe(401);
    expect((await approve(h, undefined, p.pairingId)).status).toBe(401);
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

  it("a paired remote CLI can use the relay and leave, but cannot change the account", async () => {
    const h = harness();
    const mac = await signIn(h);
    const p = await startPairing(h, "Grok Bot computer", "cli");
    await approve(h, mac.sessionToken, p.pairingId);
    const cli = (await poll(h, p)).data;
    const as = { token: cli.sessionToken };
    expect((await h.call("GET", "/v1/devices", as)).status).toBe(200);
    expect((await h.call("GET", "/v1/account", as)).status).toBe(200);
    const forbidden = [
      await h.call("GET", "/v1/keys", as),
      await h.call("GET", "/v1/sync/bookmarks/changes", as),
      await h.call("GET", "/v1/pair/lookup?code=ABCD-EFGH", as),
      await h.call("POST", "/v1/auth/passkey/register/options", { ...as, body: {} }),
      await h.call("DELETE", `/v1/devices/${mac.deviceId}`, as),
      await h.call("PATCH", `/v1/devices/${mac.deviceId}`, { ...as, body: { name: "Mine now" } }),
      await h.call("DELETE", "/v1/account", { ...as, body: { confirm: "delete my account" } }),
    ];
    expect(forbidden.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(forbidden[0]!.data.error.code).toBe("browser_only");
    expect((await h.call("DELETE", `/v1/devices/${cli.deviceId}`, as)).status).toBe(200);
  });
});
