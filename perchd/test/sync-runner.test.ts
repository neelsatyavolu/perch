import { describe, expect, test } from "bun:test";
import { SyncApi } from "../src/sync/api";
import { newSyncKey } from "../src/sync/crypto";
import { emptySyncState, SyncEngine, type LocalChange, type SyncedItem } from "../src/sync/engine";
import { makeKeyring } from "../src/sync/keyring";
import { reencryptAll, syncOnce, type SyncAdapter } from "../src/sync/runner";
import type { Collection } from "../src/sync/types";
import { fakeSyncServer } from "./sync-fake-server";

/** A local store in memory: edits queue until pushed; applied items land in `data`. */
function memoryAdapter(collection: Collection) {
  let queue: LocalChange[] = [];
  const data = new Map<string, unknown>();
  const conflicts: SyncedItem[] = [];
  const adapter: SyncAdapter = {
    collection,
    changes: async () => queue,
    pushed: async (sent) => {
      queue = queue.filter((c) => !sent.includes(c));
    },
    apply: async (items, copies) => {
      for (const item of items) (item.deleted ? data.delete(item.naturalId) : data.set(item.naturalId, item.data));
      conflicts.push(...copies);
    },
  };
  return { adapter, data, conflicts, edit: (change: LocalChange) => (queue = [...queue, change]), queued: () => queue };
}

async function setup() {
  const server = fakeSyncServer();
  const api = new SyncApi({ fetch: server.fetch, token: `pst_${"A".repeat(43)}` });
  const raw = newSyncKey();
  const keyring = await makeKeyring([{ version: 1, raw }]);
  return { server, api, raw, mac: new SyncEngine(api, keyring, "dev_mac"), laptop: new SyncEngine(api, keyring, "dev_laptop") };
}

describe("sync runner", () => {
  test("pulls, applies and pushes every collection, both ways", async () => {
    const { mac, laptop } = await setup();
    const macBookmarks = memoryAdapter("bookmarks");
    const laptopBookmarks = memoryAdapter("bookmarks");
    const laptopSettings = memoryAdapter("settings");
    macBookmarks.edit({ naturalId: "b1", updatedAt: 1, data: { url: "https://a.example" } });
    const first = await syncOnce(mac, emptySyncState, [macBookmarks.adapter]);
    expect(macBookmarks.queued()).toEqual([]);
    laptopSettings.edit({ naturalId: "theme", updatedAt: 2, data: "paper" });
    const second = await syncOnce(laptop, emptySyncState, [laptopBookmarks.adapter, laptopSettings.adapter]);
    expect(laptopBookmarks.data.get("b1")).toEqual({ url: "https://a.example" });
    expect(second.keyChanged).toBeUndefined();
    const macSettings = memoryAdapter("settings");
    await syncOnce(mac, first.state, [macBookmarks.adapter, macSettings.adapter]);
    expect(macSettings.data.get("theme")).toBe("paper");
  });

  test("keeps edits that did not fit and reports them", async () => {
    const { mac } = await setup();
    const memory = memoryAdapter("memory");
    memory.edit({ naturalId: "USER.md", updatedAt: 1, data: "notes" });
    const failing = { ...memory.adapter, pushed: async () => undefined };
    const fake = { ...mac, push: async (state: any) => ({ state, apply: [], conflictCopies: [], failed: [{ naturalId: "USER.md", reason: "quota" as const }] }), pull: mac.pull.bind(mac) };
    const result = await syncOnce(fake as unknown as SyncEngine, emptySyncState, [failing]);
    expect(result.failed).toEqual([{ collection: "memory", naturalId: "USER.md", reason: "quota" }]);
  });

  test("stops at a key change without losing local edits, then catches up and re-encrypts", async () => {
    const { server, api, raw, mac, laptop } = await setup();
    const macTabs = memoryAdapter("tabs");
    macTabs.edit({ naturalId: "t1", updatedAt: 1, data: { url: "https://a.example" } });
    const macRun = await syncOnce(mac, emptySyncState, [macTabs.adapter]);
    const laptopTabs = memoryAdapter("tabs");
    const laptopRun = await syncOnce(laptop, emptySyncState, [laptopTabs.adapter]);

    const v2 = { version: 2, raw: newSyncKey() };
    server.state.keyVersion = 2;
    const rotated = new SyncEngine(api, await makeKeyring([{ version: 1, raw }, v2]), "dev_mac");
    const moved = await reencryptAll(rotated, macRun.state, ["tabs"]);
    expect(moved.moved).toBe(1);

    laptopTabs.edit({ naturalId: "t2", updatedAt: 3, data: { url: "https://b.example" } });
    const stopped = await syncOnce(laptop, laptopRun.state, [laptopTabs.adapter]);
    expect(stopped.keyChanged).toBe(2);
    expect(laptopTabs.queued()).toHaveLength(1);
    const caughtUp = new SyncEngine(api, await makeKeyring([{ version: 1, raw }, v2]), "dev_laptop");
    const after = await syncOnce(caughtUp, stopped.state, [laptopTabs.adapter]);
    expect(after.keyChanged).toBeUndefined();
    expect(laptopTabs.queued()).toEqual([]);
    expect([...laptopTabs.data.keys()]).toEqual(["t1"]);
  });
});
