import { describe, expect, test } from "bun:test";
import { SyncApi } from "../src/sync/api";
import { newSyncKey } from "../src/sync/crypto";
import { emptySyncState, SyncEngine, SyncKeyChangedError, type SyncState } from "../src/sync/engine";
import { makeKeyring } from "../src/sync/keyring";
import { merge } from "../src/sync/merge";
import { fakeSyncServer } from "./sync-fake-server";

async function pair(options: { inlineLimit?: number } = {}) {
  const server = fakeSyncServer(options);
  const raw = newSyncKey();
  const api = new SyncApi({ fetch: server.fetch, token: `pst_${"A".repeat(43)}` });
  const keyring = await makeKeyring([{ version: 1, raw }]);
  return { server, raw, mac: new SyncEngine(api, keyring, "dev_mac"), laptop: new SyncEngine(api, keyring, "dev_laptop"), api };
}

describe("sync engine", () => {
  test("a bookmark pushed on one device arrives on another, and the server never sees it", async () => {
    const { server, mac, laptop } = await pair();
    const pushed = await mac.push(emptySyncState, "bookmarks", [{ naturalId: "b1", updatedAt: 1, data: { title: "Perch spec", url: "https://perchbrowser.com/spec" } }]);
    expect(pushed.failed).toEqual([]);
    const stored = [...server.state.items.values()][0]!;
    expect(stored.id).not.toContain("b1");
    expect(Buffer.from(stored.ciphertext!, "base64url").toString("latin1")).not.toContain("perchbrowser");
    const pulled = await laptop.pull(emptySyncState, "bookmarks");
    expect(pulled.items).toEqual([{ naturalId: "b1", updatedAt: 1, deviceId: "dev_mac", deleted: false, data: { title: "Perch spec", url: "https://perchbrowser.com/spec" } }]);
    expect(pulled.state.cursors.bookmarks).toBe(1);
    const again = await laptop.pull(pulled.state, "bookmarks");
    expect(again.items).toEqual([]);
  });

  test("the newer edit wins a conflict, and the losing device is told to apply it", async () => {
    const { mac, laptop } = await pair();
    const base = await mac.push(emptySyncState, "settings", [{ naturalId: "theme", updatedAt: 1, data: "ink" }]);
    const laptopState = (await laptop.pull(emptySyncState, "settings")).state;
    const macEdit = await mac.push(base.state, "settings", [{ naturalId: "theme", updatedAt: 5, data: "paper" }]);
    expect(macEdit.apply).toEqual([]);
    // The laptop's edit is older and based on version 1: it loses and adopts the Mac's value.
    const laptopEdit = await laptop.push(laptopState, "settings", [{ naturalId: "theme", updatedAt: 3, data: "dusk" }]);
    expect(laptopEdit.apply.map((i) => i.data)).toEqual(["paper"]);
    // A newer edit on a stale base overwrites after the merge.
    const newer = await laptop.push(laptopState, "settings", [{ naturalId: "theme", updatedAt: 9, data: "forest" }]);
    expect(newer.apply).toEqual([]);
    const final = await mac.pull(macEdit.state, "settings");
    expect(final.items.map((i) => i.data)).toEqual(["forest"]);
  });

  test("history merges visits from both devices instead of dropping one", async () => {
    const { mac, laptop } = await pair();
    const url = "https://example.com/";
    const first = await mac.push(emptySyncState, "history", [{ naturalId: url, updatedAt: 1, data: { url, title: "Example", visits: [100] } }]);
    const laptopState = (await laptop.pull(emptySyncState, "history")).state;
    await mac.push(first.state, "history", [{ naturalId: url, updatedAt: 2, data: { url, title: "Example", visits: [100, 200] } }]);
    const merged = await laptop.push(laptopState, "history", [{ naturalId: url, updatedAt: 3, data: { url, title: "Example Domain", visits: [100, 150] } }]);
    expect(merged.apply[0]!.data).toEqual({ url, title: "Example Domain", visits: [100, 150, 200] });
    const seen = await mac.pull(emptySyncState, "history");
    expect(seen.items[0]!.data).toEqual({ url, title: "Example Domain", visits: [100, 150, 200] });
  });

  test("memory keeps the losing edit as a conflict copy", async () => {
    const { mac, laptop } = await pair();
    const first = await mac.push(emptySyncState, "memory", [{ naturalId: "USER.md", updatedAt: 1, data: "Lives in Palo Alto." }]);
    const laptopState = (await laptop.pull(emptySyncState, "memory")).state;
    await mac.push(first.state, "memory", [{ naturalId: "USER.md", updatedAt: 4, data: "Lives in Palo Alto. Plays chess." }]);
    const result = await laptop.push(laptopState, "memory", [{ naturalId: "USER.md", updatedAt: 2, data: "Lives in Palo Alto. Runs." }]);
    expect(result.apply.map((i) => i.data)).toEqual(["Lives in Palo Alto. Plays chess."]);
    expect(result.conflictCopies.map((i) => i.data)).toEqual(["Lives in Palo Alto. Runs."]);
  });

  test("deletions reach other devices by their real id", async () => {
    const { mac, laptop } = await pair();
    const created = await mac.push(emptySyncState, "tabs", [{ naturalId: "tab-7", updatedAt: 1, data: { url: "https://a.example" } }]);
    const seen = await laptop.pull(emptySyncState, "tabs");
    await mac.push(created.state, "tabs", [{ naturalId: "tab-7", updatedAt: 2, deleted: true }]);
    const after = await laptop.pull(seen.state, "tabs");
    expect(after.items).toEqual([{ naturalId: "tab-7", updatedAt: expect.any(Number), deviceId: "", deleted: true }]);
    expect(Object.keys(after.state.items.tabs ?? {})).toEqual([]);
  });

  test("reads large items from the blob endpoint", async () => {
    const { mac, laptop } = await pair({ inlineLimit: 100 });
    const text = "x".repeat(5000);
    await mac.push(emptySyncState, "skills", [{ naturalId: "skill/SKILL.md", updatedAt: 1, data: text }]);
    expect((await laptop.pull(emptySyncState, "skills")).items[0]!.data).toBe(text);
  });

  test("batches commits of more than 100 items", async () => {
    const { server, mac, laptop } = await pair();
    const changes = Array.from({ length: 250 }, (_, i) => ({ naturalId: `h${i}`, updatedAt: i, data: { url: `https://e.example/${i}`, visits: [i] } }));
    await mac.push(emptySyncState, "history", changes);
    expect(server.state.commits).toBe(3);
    expect((await laptop.pull(emptySyncState, "history")).items).toHaveLength(250);
  });

  test("stops with a clear error when another device rotated the key", async () => {
    const { server, mac } = await pair();
    server.state.keyVersion = 2;
    await expect(mac.push(emptySyncState, "bookmarks", [{ naturalId: "b", updatedAt: 1, data: 1 }])).rejects.toBeInstanceOf(SyncKeyChangedError);
  });

  test("starts over when the server has purged deletions this device never saw", async () => {
    const { server, mac, laptop } = await pair();
    await mac.push(emptySyncState, "bookmarks", [{ naturalId: "keep", updatedAt: 1, data: 1 }]);
    const stale: SyncState = { cursors: { bookmarks: 1 }, items: {} };
    server.state.purgeSeq = 5;
    const result = await laptop.pull(stale, "bookmarks");
    expect(result.resync).toBe(true);
    expect(result.items.map((i) => i.naturalId)).toEqual(["keep"]);
  });

  test("counts items it can never read (damaged, or a key it holds that does not open them)", async () => {
    const { mac, api } = await pair();
    await mac.push(emptySyncState, "bookmarks", [{ naturalId: "b", updatedAt: 1, data: 1 }]);
    const wrongKey = new SyncEngine(api, await makeKeyring([{ version: 1, raw: newSyncKey() }]), "dev_x");
    const result = await wrongKey.pull(emptySyncState, "bookmarks");
    expect(result.unreadable).toBe(1);
    expect(result.items).toEqual([]);
  });

  test("stops before an item under a newer key, and gets it once it has that key", async () => {
    const { server, raw, api, mac } = await pair();
    const first = await mac.push(emptySyncState, "bookmarks", [{ naturalId: "old", updatedAt: 1, data: "a" }]);
    const laptop = new SyncEngine(api, await makeKeyring([{ version: 1, raw }]), "dev_laptop");
    const seen = await laptop.pull(emptySyncState, "bookmarks");
    // The Mac rotates and writes with version 2.
    const v2 = { version: 2, raw: newSyncKey() };
    server.state.keyVersion = 2;
    const rotatedMac = new SyncEngine(api, await makeKeyring([{ version: 1, raw }, v2]), "dev_mac");
    await rotatedMac.push(first.state, "bookmarks", [{ naturalId: "new", updatedAt: 2, data: "b" }]);
    await expect(laptop.pull(seen.state, "bookmarks")).rejects.toBeInstanceOf(SyncKeyChangedError);
    const updated = new SyncEngine(api, await makeKeyring([{ version: 1, raw }, v2]), "dev_laptop");
    const after = await updated.pull(seen.state, "bookmarks");
    expect(after.items.map((i) => i.data)).toEqual(["b"]);
    expect(after.unreadable).toBe(0);
  });

  test("does not move past an item whose blob could not be fetched", async () => {
    const { server, mac, laptop } = await pair({ inlineLimit: 100 });
    await mac.push(emptySyncState, "skills", [{ naturalId: "s", updatedAt: 1, data: "x".repeat(500) }]);
    server.state.failBlobs = true;
    await expect(laptop.pull(emptySyncState, "skills")).rejects.toThrow();
    server.state.failBlobs = false;
    expect((await laptop.pull(emptySyncState, "skills")).items.map((i) => i.naturalId)).toEqual(["s"]);
  });
});

describe("re-encryption after a rotation", () => {
  async function rotated() {
    const setup = await pair();
    const v1 = { version: 1, raw: setup.raw };
    const before = await setup.mac.push(emptySyncState, "history", [
      { naturalId: "https://a.example/", updatedAt: 1, data: { url: "https://a.example/", visits: [1] } },
      { naturalId: "https://b.example/", updatedAt: 2, data: { url: "https://b.example/", visits: [2] } },
    ]);
    const v2 = { version: 2, raw: newSyncKey() };
    setup.server.state.keyVersion = 2;
    const mac = new SyncEngine(setup.api, await makeKeyring([v1, v2]), "dev_mac");
    return { ...setup, v1, v2, before, mac };
  }

  test("moves every item to the new key, and a device with only the new key reads them all", async () => {
    const { server, api, v2, before, mac } = await rotated();
    const moved = await mac.reencrypt(before.state, "history");
    expect(moved.moved).toBe(2);
    const live = [...server.state.items.values()].filter((i) => !i.deleted);
    expect(live.map((i) => i.keyVersion)).toEqual([2, 2]);
    const fresh = new SyncEngine(api, await makeKeyring([v2]), "dev_new");
    const pulled = await fresh.pull(emptySyncState, "history");
    expect(pulled.items.filter((i) => !i.deleted).map((i) => i.naturalId).sort()).toEqual(["https://a.example/", "https://b.example/"]);
    expect(pulled.unreadable).toBe(0);
    // Running it again finds nothing left to move.
    expect((await mac.reencrypt(moved.state, "history")).moved).toBe(0);
  });

  test("another device sees the moved item, not a deletion of it", async () => {
    const { api, v1, v2, before, mac } = await rotated();
    const laptop = new SyncEngine(api, await makeKeyring([v1]), "dev_laptop");
    const seen = await laptop.pull(emptySyncState, "history");
    await mac.reencrypt(before.state, "history");
    const updated = new SyncEngine(api, await makeKeyring([v1, v2]), "dev_laptop");
    const after = await updated.pull(seen.state, "history");
    expect(after.items.filter((i) => i.deleted)).toEqual([]);
    expect(after.items.map((i) => i.naturalId).sort()).toEqual(["https://a.example/", "https://b.example/"]);
  });

  test("merges with an edit made under the new key before the move", async () => {
    const { before, mac } = await rotated();
    const edited = await mac.push(before.state, "history", [{ naturalId: "https://a.example/", updatedAt: 5, data: { url: "https://a.example/", visits: [5] } }]);
    const moved = await mac.reencrypt(edited.state, "history");
    expect(moved.moved).toBe(2);
    const all = await mac.pull(emptySyncState, "history");
    const a = all.items.find((i) => i.naturalId === "https://a.example/" && !i.deleted)!;
    expect(a.data).toEqual({ url: "https://a.example/", visits: [1, 5] });
  });

  test("an older copy moved under an edit made since the rotation is not reported as a conflict", async () => {
    const { api, raw, server } = await pair();
    const v1 = { version: 1, raw };
    const oldMac = new SyncEngine(api, await makeKeyring([v1]), "dev_mac");
    const before = await oldMac.push(emptySyncState, "memory", [{ naturalId: "USER.md", updatedAt: 1, data: "Lives in Palo Alto." }]);
    server.state.keyVersion = 2;
    const mac = new SyncEngine(api, await makeKeyring([v1, { version: 2, raw: newSyncKey() }]), "dev_mac");
    const edited = await mac.push(before.state, "memory", [{ naturalId: "USER.md", updatedAt: 3, data: "Lives in Palo Alto. Plays chess." }]);
    const moved = await mac.reencrypt(edited.state, "memory");
    expect(moved.moved).toBe(1);
    expect(moved).not.toHaveProperty("conflictCopies");
    const live = [...server.state.items.values()].filter((i) => !i.deleted);
    expect(live).toHaveLength(1);
    expect((await mac.pull(emptySyncState, "memory")).items.map((i) => i.data)).toEqual(["Lives in Palo Alto. Plays chess."]);
  });

  test("a deletion made before the move removes the old copy too, so the move cannot bring it back", async () => {
    const { server, before, mac } = await rotated();
    await mac.push(before.state, "history", [{ naturalId: "https://b.example/", updatedAt: 9, deleted: true }]);
    const moved = await mac.reencrypt(before.state, "history");
    expect(moved.moved).toBe(1);
    expect([...server.state.items.values()].filter((i) => !i.deleted)).toHaveLength(1);
  });
});

describe("merge rules", () => {
  test("equal times break by device id, the same way on every device", () => {
    const a = { id: "x", updatedAt: 5, deviceId: "dev_a", data: 1 };
    const b = { id: "x", updatedAt: 5, deviceId: "dev_b", data: 2 };
    expect(merge("settings", a, b).winner).toBe(b);
    expect(merge("settings", b, a).winner).toBe(b);
  });

  test("a newer delete beats an older edit and an older delete loses", () => {
    const edit = { id: "x", updatedAt: 5, deviceId: "dev_a", data: 1 };
    expect(merge("bookmarks", edit, { id: "x", updatedAt: 6, deviceId: "dev_b", deleted: true }).winner.deleted).toBe(true);
    expect(merge("bookmarks", edit, { id: "x", updatedAt: 4, deviceId: "dev_b", deleted: true }).winner).toBe(edit);
  });
});
