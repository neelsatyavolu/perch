/**
 * perchd's sync client (perchd/src/sync) against the real Worker routes, inside workerd: sign-in,
 * key setup, sync between devices, recovery, pairing, the encrypted relay, revocation and rotation.
 */
import { describe, expect, it } from "vitest";
import { appEnv, codeFrom, freshEmail, freshIp, harness, type Harness } from "./helpers";
import { SyncApi, type FetchLike } from "../../perchd/src/sync/api";
import { emptySyncState, SyncEngine } from "../../perchd/src/sync/engine";
import { generateDeviceKeys } from "../../perchd/src/sync/keys";
import { approvePairing, createSyncKey, loadSyncKey, makeKeyring, recoverSyncKey, rotateSyncKey, type ThisDevice } from "../../perchd/src/sync/keyring";
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
    const macEngine = new SyncEngine(mac.api, await makeKeyring([created.key]), mac.device.id);
    const pushed = await macEngine.push(emptySyncState, "bookmarks", [{ naturalId: "b1", updatedAt: 1, data: { title: "Perch", url: "https://perchbrowser.com" } }]);
    expect(pushed.failed).toEqual([]);

    const laptop = await signInDevice(h, email, "Laptop");
    expect(await loadSyncKey(laptop.api, laptop.device)).toBeNull();
    const recovered = await recoverSyncKey(laptop.api, laptop.device, created.recoveryKey);
    expect(recovered.recoveryPublicKey).toBe(created.recoveryPublicKey);
    expect(await loadSyncKey(laptop.api, laptop.device)).toEqual(recovered.key);
    const laptopEngine = new SyncEngine(laptop.api, await makeKeyring([recovered.key]), laptop.device.id);
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

    const botKeys = await generateDeviceKeys();
    const anonymous = new SyncApi({ fetch: fetchVia(h) });
    const start = await anonymous.startPairing({ name: "Grok Bot computer", kind: "cli", publicKey: botKeys.publicKey });
    const lookup = await mac.api.lookupPairing(start.code);
    const approved = await approvePairing(mac.api, lookup, start.code, created.key);
    const polled = await anonymous.pollPairing(start);
    if (polled.status !== "approved") throw new Error("not approved");
    expect(polled.deviceId).toBe(approved.deviceId);
    // A remote CLI gets no sync key.
    expect((await anonymous.withToken(polled.sessionToken).keys()).device).toBeNull();
    const macPeer = polled.peers.find((p) => p.id === polled.approverDeviceId)!;
    expect(macPeer.publicKey).toBe(mac.device.keys.publicKey);

    const macRelay = new RelayClient({ token: mac.token, me: mac.device, trusted: [approved.trusted], connect: socketVia(h) });
    const botRelay = new RelayClient({ token: polled.sessionToken, me: { id: polled.deviceId, keys: botKeys }, trusted: [{ id: macPeer.id, publicKey: macPeer.publicKey }], connect: socketVia(h) });
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
    expect(calls).toEqual([polled.deviceId]);
    macRelay.close();
    botRelay.close();
  });

  it("revokes a device, rotates the key for the rest, and keeps recovery working", async () => {
    const h = harness();
    const email = freshEmail();
    const mac = await signInDevice(h, email, "Studio");
    const created = await createSyncKey(mac.api, mac.device, { iterations: MIN_ITERATIONS });
    const lost = await signInDevice(h, email, "Lost laptop");
    await recoverSyncKey(lost.api, lost.device, created.recoveryKey);

    await mac.api.revokeDevice(lost.device.id);
    const rotated = await rotateSyncKey(mac.api, mac.device, [{ id: lost.device.id, publicKey: lost.device.keys.publicKey }], created.recoveryPublicKey);
    expect(rotated.version).toBe(2);
    await expect(lost.api.keys()).rejects.toMatchObject({ status: 401 });

    const engine = new SyncEngine(mac.api, await makeKeyring([created.key, rotated]), mac.device.id);
    await engine.push(emptySyncState, "settings", [{ naturalId: "theme", updatedAt: 1, data: "paper" }]);
    const fresh = await signInDevice(h, email, "New Mac");
    const recovered = await recoverSyncKey(fresh.api, fresh.device, created.recoveryKey);
    expect(recovered.key).toEqual(rotated);
    const pulled = await new SyncEngine(fresh.api, await makeKeyring([recovered.key]), fresh.device.id).pull(emptySyncState, "settings");
    expect(pulled.items.map((i) => i.data)).toEqual(["paper"]);
  });
});
