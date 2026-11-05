import { describe, expect, it } from "vitest";
import { device, freshEmail, harness, signIn } from "./helpers";

const blob = (tag: string) => `wrapped_${tag}_${"A".repeat(40)}`;

describe("devices", () => {
  it("lists the account's devices and marks the current one", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await signIn(h, email, await device("Studio"));
    const b = await signIn(h, email, await device("Laptop"));
    const { data } = await h.call("GET", "/v1/devices", { token: b.sessionToken });
    expect(data.devices.map((d: any) => [d.name, d.current])).toEqual([["Studio", false], ["Laptop", true]]);
    expect(data.devices[0].publicKey).toHaveLength(87);
    expect(data.devices[0].id).toBe(a.deviceId);
  });

  it("renames a device", async () => {
    const h = harness();
    const a = await signIn(h);
    expect((await h.call("PATCH", `/v1/devices/${a.deviceId}`, { token: a.sessionToken, body: { name: "Office iMac" } })).status).toBe(200);
    const { data } = await h.call("GET", "/v1/devices", { token: a.sessionToken });
    expect(data.devices[0].name).toBe("Office iMac");
  });

  it("revoking a device ends its sessions and deletes its key copy", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await signIn(h, email);
    const b = await signIn(h, email);
    await h.call("POST", "/v1/keys/rotate", { token: a.sessionToken, body: { version: 1, devices: { [a.deviceId]: blob("a"), [b.deviceId]: blob("b") } } });
    expect((await h.call("GET", "/v1/keys", { token: b.sessionToken })).data.device).toEqual({ version: 1, blob: blob("b") });
    expect((await h.call("DELETE", `/v1/devices/${b.deviceId}`, { token: a.sessionToken })).status).toBe(200);
    expect((await h.call("GET", "/v1/keys", { token: b.sessionToken })).status).toBe(401);
    const { data } = await h.call("GET", "/v1/devices", { token: a.sessionToken });
    expect(data.devices.map((d: any) => d.id)).toEqual([a.deviceId]);
    // A revoked device cannot be handed a key again.
    expect((await h.call("PUT", `/v1/keys/devices/${b.deviceId}`, { token: a.sessionToken, body: { version: 1, blob: blob("b2") } })).status).toBe(409);
  });

  it("cannot touch another account's devices", async () => {
    const h = harness();
    const a = await signIn(h);
    const other = await signIn(h);
    expect((await h.call("DELETE", `/v1/devices/${other.deviceId}`, { token: a.sessionToken })).status).toBe(404);
    expect((await h.call("PATCH", `/v1/devices/${other.deviceId}`, { token: a.sessionToken, body: { name: "Mine" } })).status).toBe(404);
    expect((await h.call("PUT", `/v1/keys/devices/${other.deviceId}`, { token: a.sessionToken, body: { version: 1, blob: blob("x") } })).status).toBe(409);
  });

  it("signing out is revoking the current device", async () => {
    const h = harness();
    const a = await signIn(h);
    expect((await h.call("DELETE", `/v1/devices/${a.deviceId}`, { token: a.sessionToken })).status).toBe(200);
    expect((await h.call("GET", "/v1/account", { token: a.sessionToken })).status).toBe(401);
  });

  it("extends a session that is used, and expires one that is not", async () => {
    const h = harness();
    const a = await signIn(h);
    const day = 24 * 60 * 60 * 1000;
    h.clock.now += 80 * day;
    expect((await h.call("GET", "/v1/account", { token: a.sessionToken })).status).toBe(200);
    h.clock.now += 80 * day;
    expect((await h.call("GET", "/v1/account", { token: a.sessionToken })).status).toBe(200);
    h.clock.now += 91 * day;
    expect((await h.call("GET", "/v1/account", { token: a.sessionToken })).status).toBe(401);
  });
});

describe("keys", () => {
  it("starts with no key, then the first rotation creates version 1 with a recovery copy", async () => {
    const h = harness();
    const a = await signIn(h);
    expect((await h.call("GET", "/v1/keys", { token: a.sessionToken })).data).toEqual({ keyVersion: 0, device: null, recovery: null });
    const rotated = await h.call("POST", "/v1/keys/rotate", { token: a.sessionToken, body: { version: 1, devices: { [a.deviceId]: blob("a") }, recovery: blob("r") } });
    expect(rotated.data).toEqual({ ok: true, keyVersion: 1, skipped: [] });
    expect((await h.call("GET", "/v1/keys", { token: a.sessionToken })).data).toEqual({
      keyVersion: 1, device: { version: 1, blob: blob("a") }, recovery: { version: 1, blob: blob("r") },
    });
  });

  it("refuses a rotation that skips or repeats a version", async () => {
    const h = harness();
    const a = await signIn(h);
    const rotate = (version: number) => h.call("POST", "/v1/keys/rotate", { token: a.sessionToken, body: { version, devices: { [a.deviceId]: blob(String(version)) } } });
    expect((await rotate(2)).status).toBe(409);
    expect((await rotate(1)).status).toBe(200);
    expect((await rotate(1)).status).toBe(409);
    expect((await rotate(2)).status).toBe(200);
    expect((await h.call("GET", "/v1/keys", { token: a.sessionToken })).data.device).toEqual({ version: 2, blob: blob("2") });
  });

  it("requires the rotating device to keep a copy, and drops copies for devices left out", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await signIn(h, email);
    const b = await signIn(h, email);
    expect((await h.call("POST", "/v1/keys/rotate", { token: a.sessionToken, body: { version: 1, devices: { [b.deviceId]: blob("b") } } })).status).toBe(400);
    await h.call("POST", "/v1/keys/rotate", { token: a.sessionToken, body: { version: 1, devices: { [a.deviceId]: blob("a"), [b.deviceId]: blob("b") } } });
    await h.call("POST", "/v1/keys/rotate", { token: a.sessionToken, body: { version: 2, devices: { [a.deviceId]: blob("a2") } } });
    expect((await h.call("GET", "/v1/keys", { token: b.sessionToken })).data.device).toBeNull();
  });

  it("grants the current key to another device, and refuses stale versions", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await signIn(h, email);
    const b = await signIn(h, email);
    await h.call("POST", "/v1/keys/rotate", { token: a.sessionToken, body: { version: 1, devices: { [a.deviceId]: blob("a") } } });
    expect((await h.call("PUT", `/v1/keys/devices/${b.deviceId}`, { token: a.sessionToken, body: { version: 1, blob: blob("b") } })).status).toBe(200);
    expect((await h.call("PUT", `/v1/keys/devices/${b.deviceId}`, { token: a.sessionToken, body: { version: 2, blob: blob("b") } })).status).toBe(409);
    expect((await h.call("PUT", "/v1/keys/recovery", { token: a.sessionToken, body: { version: 1, blob: blob("r") } })).status).toBe(200);
    expect((await h.call("GET", "/v1/keys", { token: b.sessionToken })).data.recovery).toEqual({ version: 1, blob: blob("r") });
  });

  it("checks blob format", async () => {
    const h = harness();
    const a = await signIn(h);
    const res = await h.call("POST", "/v1/keys/rotate", { token: a.sessionToken, body: { version: 1, devices: { [a.deviceId]: "not base64url!" } } });
    expect(res.status).toBe(400);
  });
});
