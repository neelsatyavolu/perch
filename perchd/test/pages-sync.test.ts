import { expect, test } from "bun:test";
import { syncPages } from "../src/app/pages/sync";
import type { PagesDeps } from "../src/app/pages/deps";
import { SyncApi } from "../src/sync/api";
import { BrowserSync, type SavedState } from "../src/sync/browser-sync";
import { newSyncKey } from "../src/sync/crypto";
import type { Paired, PendingPairing } from "../src/sync/keyring";
import { memorySecretStore } from "../src/sync/keychain";
import { fakeBrowser } from "./fake-browser-data";
import { fakeSyncServer } from "./sync-fake-server";

function service() {
  const sync = fakeSyncServer();
  const api = new SyncApi({
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/v1/devices") return Response.json({ devices: [{ id: "dev_mac", name: "Mac", kind: "browser", publicKey: "k", createdAt: 1, lastSeenAt: 2 }] });
      return sync.fetch(input, init);
    },
  });
  let polls = 0;
  const pending: PendingPairing = { start: { pairingId: "p1", code: "c", pollSecret: "s", expiresAt: Date.now() + 60_000 }, code: { lookup: "ABCD", secret: "EFGH", display: "ABCD-EFGH-JKLM" } };
  let saved: SavedState | null = null;
  return new BrowserSync({
    domain: fakeBrowser().domain,
    secrets: memorySecretStore(),
    api,
    state: { load: async () => saved, save: async (s) => void (saved = s) },
    pairing: {
      start: async () => pending,
      complete: async (): Promise<Paired | null> => (++polls < 2 ? null : { sessionToken: `pst_${"A".repeat(43)}`, accountId: "a", deviceId: "dev_mac", trusted: [], keys: [{ version: 1, raw: newSyncKey() }] }),
    },
  });
}

const deps = (extra: Partial<PagesDeps>) => extra as PagesDeps;

test("pairing through the pages API turns sync on", async () => {
  const pages = syncPages(deps({ sync: service() }));
  expect((await pages.getSync([])).on).toBe(false);
  const pairing = await pages.startSyncPairing([]);
  expect(pairing.qr).toStartWith("perch://pair?code=");
  expect(await pages.checkSyncPairing([pairing.pairingId])).toBeNull();
  const status = await pages.checkSyncPairing([pairing.pairingId]);
  expect(status?.on).toBe(true);
  expect(status?.devices.map((d) => d.current)).toEqual([true]);
  expect((await pages.syncNow([])).lastSync).not.toBeNull();
  await expect(pages.removeSyncDevice(["dev_mac"])).rejects.toThrow("turn sync off");
  expect((await pages.turnOffSync([])).on).toBe(false);
});

test("bad input, no browser, and a policy that turns sync off", async () => {
  const pages = syncPages(deps({ sync: service() }));
  await expect(pages.checkSyncPairing([42])).rejects.toThrow();
  await expect(pages.checkSyncPairing(["nope"])).rejects.toThrow("Start again");
  await expect(syncPages(deps({})).getSync([])).rejects.toMatchObject({ status: 501 });
  const managed = syncPages(deps({ sync: service(), policy: { current: () => ({ SyncEnabled: false }) } }));
  await expect(managed.startSyncPairing([])).rejects.toMatchObject({ status: 403, message: "Your organization turned off sync." });
});
