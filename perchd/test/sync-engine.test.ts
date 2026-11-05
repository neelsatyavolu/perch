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

  test("counts items it cannot read instead of failing the pull", async () => {
    const { mac, api } = await pair();
    await mac.push(emptySyncState, "bookmarks", [{ naturalId: "b", updatedAt: 1, data: 1 }]);
    const wrongKey = new SyncEngine(api, await makeKeyring([{ version: 1, raw: newSyncKey() }]), "dev_x");
    const result = await wrongKey.pull(emptySyncState, "bookmarks");
    expect(result.unreadable).toBe(1);
    expect(result.items).toEqual([]);
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
