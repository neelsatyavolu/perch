/**
 * perchd's sync client (perchd/src/sync) against the real Worker routes, inside workerd: sign-in,
 * key setup, sync between devices, recovery, pairing, the encrypted relay, revocation and rotation.
 */
import { describe, expect, it } from "vitest";
import { appEnv, codeFrom, freshEmail, freshIp, harness, type Harness } from "./helpers";
import { SyncApi, type FetchLike } from "../../perchd/src/sync/api";
import { emptySyncState, SyncEngine } from "../../perchd/src/sync/engine";
import { generateDeviceKeys } from "../../perchd/src/sync/keys";
import type { VersionedKey } from "../../perchd/src/sync/keys";
import { approvePairing, completePairing, createSyncKey, loadSyncKeys, makeKeyring, recoverSyncKey, rotateSyncKey, startPairing, type ThisDevice } from "../../perchd/src/sync/keyring";
import type { DeviceKind } from "../../perchd/src/sync/types";
import { MIN_ITERATIONS } from "../../perchd/src/sync/recovery";
import { RelayClient, serveRemoteMcp, type SocketLike } from "../../perchd/src/sync/relay-client";

const fetchVia = (h: Harness): FetchLike => {
  const ip = freshIp();
  return async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("cf-connecting-ip", ip);
    return h.app.fetch(request, appEnv);
  };
};

/** Signs a device in by email code, as perchd would. */
async function signInDevice(h: Harness, email: string, name: string, kind: "browser" | "cli" = "browser") {
  const keys = await generateDeviceKeys();
  const anonymous = new SyncApi({ fetch: fetchVia(h) });
  const start = await anonymous.startEmail(email, { name, kind, publicKey: keys.publicKey });
  const done = await anonymous.verifyEmailCode(start, codeFrom(h.mailer.sent.at(-1)!.text));
  if (done.status !== "signed_in") throw new Error("not signed in");
  const device: ThisDevice = { id: done.deviceId, keys };
  return { api: anonymous.withToken(done.sessionToken), device, token: done.sessionToken };
}

/** A SocketLike over a WebSocket upgrade answered by the Worker in this test. */
function socketVia(h: Harness): (url: string, token: string) => SocketLike {
  return (_url, token) => {
    const listeners: Record<string, ((event: any) => void)[]> = {};
    const emit = (type: string, event: unknown) => listeners[type]?.forEach((l) => l(event));
    const ready = h.call("GET", "/v1/relay", { token, headers: { Upgrade: "websocket" } }).then(({ res }) => {
      const ws = res.webSocket;
      if (!ws) throw new Error(`relay refused: ${res.status}`);
      ws.addEventListener("message", (event) => emit("message", { data: event.data }));
      ws.addEventListener("close", (event) => emit("close", { code: event.code }));
      ws.accept();
      emit("open", {});
      return ws;
    });
    ready.catch(() => emit("error", {}));
    return {
      send: (data) => void ready.then((ws) => ws.send(data)),
      close: (code, reason) => void ready.then((ws) => ws.close(code, reason)),
      addEventListener: (type, listener) => void (listeners[type] ??= []).push(listener),
    };
  };
}

describe("sync client against the server", () => {
  it("syncs bookmarks between two Macs and recovers the key on the second one", async () => {
    const h = harness();
    const email = freshEmail();
    const mac = await signInDevice(h, email, "Studio");
    const created = await createSyncKey(mac.api, mac.device, { iterations: MIN_ITERATIONS });
    const macEngine = new SyncEngine(mac.api, await makeKeyring(created.keys), mac.device.id);
    const pushed = await macEngine.push(emptySyncState, "bookmarks", [{ naturalId: "b1", updatedAt: 1, data: { title: "Perch", url: "https://perchbrowser.com" } }]);
    expect(pushed.failed).toEqual([]);

    const laptop = await signInDevice(h, email, "Laptop");
    expect(await loadSyncKeys(laptop.api, laptop.device)).toBeNull();
    const recovered = await recoverSyncKey(laptop.api, laptop.device, created.recoveryKey);
    expect(recovered.recoveryPublicKey).toBe(created.recoveryPublicKey);
    expect(await loadSyncKeys(laptop.api, laptop.device)).toEqual(recovered.keys);
    const laptopEngine = new SyncEngine(laptop.api, await makeKeyring(recovered.keys), laptop.device.id);
    const pulled = await laptopEngine.pull(emptySyncState, "bookmarks");
    expect(pulled.items.map((i) => i.data)).toEqual([{ title: "Perch", url: "https://perchbrowser.com" }]);

    // What the server holds is opaque.
    const row = await appEnv.DB.prepare("SELECT id, data FROM items WHERE account_id = ?").bind((await mac.api.account()).id).first<{ id: string; data: string }>();
    expect(row!.id).not.toContain("b1");
    expect(atob(row!.data.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("perchbrowser");
  });

  it("pairs a remote CLI by code and carries remote MCP through the relay, end to end encrypted", async () => {
    const h = harness();
    const mac = await signInDevice(h, freshEmail(), "Studio");
    const created = await createSyncKey(mac.api, mac.device, { iterations: MIN_ITERATIONS });

    const bot = await pairDevice(h, mac, { keys: created.keys, recoveryPublicKey: created.recoveryPublicKey }, "Grok Bot computer", "cli");
    // A remote CLI gets no sync key and cannot read sync data.
    expect(bot.paired.keys).toBeUndefined();
    await expect(bot.api.keys()).rejects.toMatchObject({ status: 403 });
    // It trusts the Mac's key from the sealed grant, never from the server's device list.
    expect(bot.paired.trusted).toEqual([{ id: mac.device.id, publicKey: mac.device.keys.publicKey }]);

    const macRelay = new RelayClient({ token: mac.token, me: mac.device, trusted: [bot.approved.trusted], connect: socketVia(h) });
    const botRelay = new RelayClient({ token: bot.paired.sessionToken, me: bot.device, trusted: bot.paired.trusted, connect: socketVia(h) });
    await macRelay.connect();
    await botRelay.connect();
    const calls: string[] = [];
    serveRemoteMcp(macRelay, async (from, body: any) => {
      calls.push(from);
      return { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "3 tabs open" }] } };
    });
    const reply = new Promise((resolve) => botRelay.on("message", (_from, message) => resolve(message)));
    const online = new Promise<void>((resolve) => botRelay.on("presence", (ids) => ids.includes(mac.device.id) && resolve()));
    await online;
    await botRelay.send(mac.device.id, { kind: "mcp", body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "tabs" } } });
    expect(await reply).toEqual({ kind: "mcp", body: { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "3 tabs open" }] } } });
    expect(calls).toEqual([bot.device.id]);
    macRelay.close();
    botRelay.close();
  });

  it("refuses an approval when the server swaps the waiting device's key", async () => {
    const h = harness();
    const mac = await signInDevice(h, freshEmail(), "Studio");
    const keys = await generateDeviceKeys();
    const pending = await startPairing(new SyncApi({ fetch: fetchVia(h) }), { name: "New MacBook", kind: "browser", publicKey: keys.publicKey });
    const lookup = await mac.api.lookupPairing(pending.code.lookup);
    const swapped = { ...lookup, publicKey: (await generateDeviceKeys()).publicKey };
    await expect(approvePairing(mac.api, swapped, pending.code.display, { device: mac.device })).rejects.toThrow("does not match");
  });

  it("revokes a device, rotates the key, re-encrypts, and recovery still reads data from before and after", async () => {
    const h = harness();
    const email = freshEmail();
    const mac = await signInDevice(h, email, "Studio");
    const created = await createSyncKey(mac.api, mac.device, { iterations: MIN_ITERATIONS });
    const before = await new SyncEngine(mac.api, await makeKeyring(created.keys), mac.device.id)
      .push(emptySyncState, "settings", [{ naturalId: "theme", updatedAt: 1, data: "paper" }]);
    const lost = await signInDevice(h, email, "Lost laptop");
    await recoverSyncKey(lost.api, lost.device, created.recoveryKey);

    await mac.api.revokeDevice(lost.device.id);
    const keys = await rotateSyncKey(mac.api, mac.device, [{ id: lost.device.id, publicKey: lost.device.keys.publicKey }], created);
    expect(keys.map((k) => k.version)).toEqual([1, 2]);
    await expect(lost.api.keys()).rejects.toMatchObject({ status: 401 });

    const engine = new SyncEngine(mac.api, await makeKeyring(keys), mac.device.id);
    const after = await engine.push(before.state, "settings", [{ naturalId: "zoom", updatedAt: 2, data: 125 }]);

    // A device recovered now holds both versions, so it reads items from before the rotation even before they move.
    const fresh = await signInDevice(h, email, "New Mac");
    const recovered = await recoverSyncKey(fresh.api, fresh.device, created.recoveryKey);
    expect(recovered.keys).toEqual(keys);
    const early = await new SyncEngine(fresh.api, await makeKeyring(recovered.keys), fresh.device.id).pull(emptySyncState, "settings");
    expect(early.items.map((i) => i.data).sort()).toEqual([125, "paper"]);

    const moved = await engine.reencrypt(after.state, "settings");
    expect(moved.moved).toBe(1);
    const rows = await appEnv.DB.prepare("SELECT key_version FROM items WHERE account_id = ? AND deleted = 0").bind((await mac.api.account()).id).all<{ key_version: number }>();
    expect(rows.results.map((r) => r.key_version)).toEqual([2, 2]);
    const onlyNew = await new SyncEngine(fresh.api, await makeKeyring(keys.filter((k) => k.version === 2)), fresh.device.id).pull(emptySyncState, "settings");
    expect(onlyNew.items.filter((i) => !i.deleted).map((i) => i.data).sort()).toEqual([125, "paper"]);
    expect(onlyNew.unreadable).toBe(0);
  });

  it("a Mac paired by code gets the keys and recovery fingerprint, so it can rotate without dropping recovery", async () => {
    const h = harness();
    const email = freshEmail();
    const mac = await signInDevice(h, email, "Studio");
    const created = await createSyncKey(mac.api, mac.device, { iterations: MIN_ITERATIONS });
    const laptop = await pairDevice(h, mac, { keys: created.keys, recoveryPublicKey: created.recoveryPublicKey }, "MacBook Air", "browser");
    expect(laptop.paired.keys).toEqual(created.keys);
    expect(laptop.paired.recoveryPublicKey).toBe(created.recoveryPublicKey);
    expect(await loadSyncKeys(laptop.api, laptop.device)).toEqual(created.keys);

    await laptop.api.revokeDevice(mac.device.id);
    const keys = await rotateSyncKey(laptop.api, laptop.device, [], { keys: laptop.paired.keys!, recoveryPublicKey: laptop.paired.recoveryPublicKey });
    const info = await laptop.api.keys();
    expect(info.recovery?.version).toBe(2);
    const fresh = await signInDevice(h, email, "New Mac");
    expect((await recoverSyncKey(fresh.api, fresh.device, created.recoveryKey)).keys).toEqual(keys);
  });

  it("refuses to rotate on a device that cannot update the recovery copy", async () => {
    const h = harness();
    const mac = await signInDevice(h, freshEmail(), "Studio");
    const created = await createSyncKey(mac.api, mac.device, { iterations: MIN_ITERATIONS });
    const laptop = await pairDevice(h, mac, { keys: created.keys }, "MacBook Air", "browser");
    await expect(rotateSyncKey(laptop.api, laptop.device, [], { keys: laptop.paired.keys! })).rejects.toThrow("recovery");
    expect((await laptop.api.keys()).keyVersion).toBe(1);
  });

  it("tells the caller which items did not fit when the account is full", async () => {
    const h = harness();
    const mac = await signInDevice(h, freshEmail(), "Studio");
    const created = await createSyncKey(mac.api, mac.device, { iterations: MIN_ITERATIONS });
    const original = appEnv.QUOTA_BYTES;
    appEnv.QUOTA_BYTES = "200";
    try {
      const pushed = await new SyncEngine(mac.api, await makeKeyring(created.keys), mac.device.id)
        .push(emptySyncState, "memory", [{ naturalId: "USER.md", updatedAt: 1, data: "x".repeat(400) }]);
      expect(pushed.failed).toEqual([{ naturalId: "USER.md", reason: "quota" }]);
    } finally {
      appEnv.QUOTA_BYTES = original;
    }
  });
});

/** Pairs a new device with `approver` by code, as `perch login` and Settings would. */
async function pairDevice(
  h: Harness,
  approver: Awaited<ReturnType<typeof signInDevice>>,
  from: { keys?: VersionedKey[]; recoveryPublicKey?: string },
  name: string,
  kind: DeviceKind,
) {
  const keys = await generateDeviceKeys();
  const anonymous = new SyncApi({ fetch: fetchVia(h) });
  const pending = await startPairing(anonymous, { name, kind, publicKey: keys.publicKey });
  expect(await completePairing(anonymous, pending, keys)).toBeNull();
  const lookup = await approver.api.lookupPairing(pending.code.lookup);
  const approved = await approvePairing(approver.api, lookup, pending.code.display, { device: approver.device, ...from });
  const paired = await completePairing(anonymous, pending, keys);
  if (!paired) throw new Error("not approved");
  expect(paired.deviceId).toBe(approved.deviceId);
  const device: ThisDevice = { id: paired.deviceId, keys };
  return { paired, approved, device, api: anonymous.withToken(paired.sessionToken) };
}
