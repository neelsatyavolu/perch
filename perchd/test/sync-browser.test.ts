import { describe, expect, test } from "bun:test";
import { SyncApi, type FetchLike } from "../src/sync/api";
import { BrowserSync, type SavedState } from "../src/sync/browser-sync";
import { newSyncKey } from "../src/sync/crypto";
import type { Paired, PendingPairing } from "../src/sync/keyring";
import { memorySecretStore } from "../src/sync/keychain";
import type { Device } from "../src/sync/types";
import { fakeBrowser } from "./fake-browser-data";
import { fakeSyncServer } from "./sync-fake-server";

/** The fake sync routes plus the device list. */
function server() {
  const sync = fakeSyncServer();
  let devices: Device[] = [
    { id: "dev_mac", name: "Mac", kind: "browser", publicKey: "k1", createdAt: 1, lastSeenAt: 2 },
    { id: "dev_laptop", name: "Laptop", kind: "browser", publicKey: "k2", createdAt: 1, lastSeenAt: 3 },
  ];
  const revoked: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/v1/devices") return new Response(JSON.stringify({ devices }), { headers: { "content-type": "application/json" } });
    if (url.pathname.startsWith("/v1/devices/") && init?.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice(12));
      revoked.push(id);
      devices = devices.filter((d) => d.id !== id);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    return sync.fetch(input, init);
  };
  return { api: new SyncApi({ fetch }), revoked };
}

function memoryState() {
  let saved: SavedState | null = null;
  return { load: async () => saved, save: async (s: SavedState) => void (saved = s), get: () => saved };
}

/** Pairing stubs: the other device approves on the second poll. */
function pairingWith(deviceId: string, keys: Paired["keys"]) {
  let polls = 0;
  const pending: PendingPairing = {
    start: { pairingId: `p-${deviceId}`, code: "c", pollSecret: "s", expiresAt: Date.now() + 60_000 },
    code: { lookup: "ABCD", secret: "EFGH", display: "ABCD-EFGH-JKLM" },
  };
  return {
    start: async () => pending,
    complete: async (): Promise<Paired | null> => (++polls < 2 ? null : { sessionToken: `pst_${"A".repeat(43)}`, accountId: "acct", deviceId, trusted: [], ...(keys ? { keys } : {}) }),
  };
}

async function pairedDevice(deviceId: string, keys: Paired["keys"], api: SyncApi) {
  const browser = fakeBrowser();
  const secrets = memorySecretStore();
  const state = memoryState();
  const sync = new BrowserSync({ domain: browser.domain, secrets, api, state, pairing: pairingWith(deviceId, keys) });
  const { pairingId } = await sync.startPairing();
  await sync.checkPairing(pairingId);
  await sync.checkPairing(pairingId);
  return { browser, secrets, state, sync };
}

describe("sync in the browser", () => {
  test("pairing shows a QR and code, and turns sync on once the other device approves", async () => {
    const { api } = server();
    const secrets = memorySecretStore();
    const sync = new BrowserSync({ domain: fakeBrowser().domain, secrets, api, state: memoryState(), pairing: pairingWith("dev_mac", [{ version: 1, raw: newSyncKey() }]) });
    expect((await sync.status()).on).toBe(false);
    const pairing = await sync.startPairing();
    expect(pairing.qr).toBe("perch://pair?code=ABCDEFGHJKLM");
    expect(pairing.code).toBe("ABCD-EFGH-JKLM");
    expect(await sync.checkPairing(pairing.pairingId)).toBe(false);
    expect(await secrets.get("session-token")).toBeNull();
    expect(await sync.checkPairing(pairing.pairingId)).toBe(true);
    const status = await sync.status();
    expect(status.on).toBe(true);
    expect(status.devices.map((d) => [d.name, d.current])).toEqual([["Mac", true], ["Laptop", false]]);
    await expect(sync.startPairing()).rejects.toThrow("already on");
  });

  test("a bookmark made on one Mac reaches the other on its next pass", async () => {
    const { api } = server();
    const keys = [{ version: 1, raw: newSyncKey() }];
    const mac = await pairedDevice("dev_mac", keys, api);
    const laptop = await pairedDevice("dev_laptop", keys, api);
    mac.browser.addBookmark(0, "Example", "https://example.com/");
    mac.browser.visits.push({ url: "https://a.example/", title: "A", time: 10 });
    expect((await mac.sync.syncNow())?.failed).toEqual([]);
    await laptop.sync.syncNow();
    expect(laptop.browser.roots[0]!.children!.map((n) => n.url)).toEqual(["https://example.com/"]);
    expect(laptop.browser.added.map((v) => v.url)).toEqual(["https://a.example/"]);
    expect(laptop.state.get()?.sync.cursors.bookmarks).toBeGreaterThan(0);
    expect((await laptop.sync.status()).lastSync).not.toBeNull();
  });

  test("no pass while sync is off, while policy forbids it, or before the key arrives", async () => {
    const { api } = server();
    const off = new BrowserSync({ domain: fakeBrowser().domain, secrets: memorySecretStore(), api, state: memoryState() });
    expect(await off.syncNow()).toBeNull();
    const keys = [{ version: 1, raw: newSyncKey() }];
    const mac = await pairedDevice("dev_mac", keys, api);
    const blocked = new BrowserSync({ domain: mac.browser.domain, secrets: mac.secrets, api, state: mac.state, allowed: () => false });
    expect(await blocked.syncNow()).toBeNull();
    expect(mac.state.get()).toBeNull();
  });

  test("a browser without the data methods syncs nothing and does not fail", async () => {
    const { api } = server();
    const keys = [{ version: 1, raw: newSyncKey() }];
    const mac = await pairedDevice("dev_mac", keys, api);
    const bare = { getBookmarks: async () => null, applyBookmarkChanges: async () => null, getHistory: async () => null, addHistory: async () => null, getOpenTabs: async () => null };
    const sync = new BrowserSync({ domain: bare, secrets: mac.secrets, api, state: mac.state });
    const run = await sync.syncNow();
    expect(run?.failed).toEqual([]);
    expect((await sync.status()).lastError).toBeNull();
  });

  test("removing another device revokes it; turning sync off forgets this Mac's keys", async () => {
    const { api, revoked } = server();
    const mac = await pairedDevice("dev_mac", [{ version: 1, raw: newSyncKey() }], api);
    await expect(mac.sync.removeDevice("dev_mac")).rejects.toThrow("turn sync off");
    await mac.sync.removeDevice("dev_laptop");
    expect((await mac.sync.status()).devices.map((d) => d.id)).toEqual(["dev_mac"]);
    await mac.sync.turnOff();
    expect(revoked).toEqual(["dev_laptop", "dev_mac"]);
    expect(await mac.secrets.get("device-keys")).toBeNull();
    expect(await mac.secrets.get("sync-keys")).toBeNull();
    expect((await mac.sync.status()).on).toBe(false);
  });

  test("the timer runs a pass at start and then on its interval", async () => {
    const { api } = server();
    const mac = await pairedDevice("dev_mac", [{ version: 1, raw: newSyncKey() }], api);
    let reads = 0;
    const domain = { ...mac.browser.domain, getOpenTabs: async () => (reads++, { windows: [] }) };
    const sync = new BrowserSync({ domain, secrets: mac.secrets, api, state: mac.state, intervalMs: 20 });
    const stop = sync.start();
    await new Promise((r) => setTimeout(r, 70));
    stop();
    const seen = reads;
    expect(seen).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toBeLessThanOrEqual(seen + 2);
  });
});
