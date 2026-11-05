import { describe, expect, it } from "vitest";
import { appEnv, freshEmail, harness, signIn, type Harness, type Session } from "./helpers";
import { cleanup } from "../src/cleanup";
import { toBase64Url } from "../src/crypto";

const itemId = (n: number) => `item${String(n).padStart(20, "0")}`;
const cipher = (bytes: number, fill = 7) => toBase64Url(new Uint8Array(bytes).fill(fill));

async function ready(h: Harness, email = freshEmail()): Promise<Session> {
  const s = await signIn(h, email);
  await h.call("POST", "/v1/keys/rotate", { token: s.sessionToken, body: { version: 1, devices: { [s.deviceId]: `w${"A".repeat(30)}` } } });
  return s;
}

const commit = (h: Harness, s: Session, items: unknown[], collection = "bookmarks") =>
  h.call("POST", `/v1/sync/${collection}/commit`, { token: s.sessionToken, body: { items } });

describe("sync", () => {
  it("stores an item at version 1 and returns it from changes", async () => {
    const h = harness();
    const s = await ready(h);
    const res = await commit(h, s, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(40) }]);
    expect(res.data.results).toEqual([{ id: itemId(1), status: "ok", version: 1, seq: 1 }]);
    const changes = await h.call("GET", "/v1/sync/bookmarks/changes?after=0", { token: s.sessionToken });
    expect(changes.data.items).toHaveLength(1);
    expect(changes.data.items[0]).toMatchObject({ id: itemId(1), version: 1, keyVersion: 1, seq: 1, size: 40, deleted: false, ciphertext: cipher(40) });
    expect(changes.data.next).toBe(1);
    expect(changes.data.more).toBe(false);
  });

  it("returns a conflict with the current ciphertext when the base version is stale", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await ready(h, email);
    const b = await signIn(h, email);
    await commit(h, a, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(10, 1) }]);
    await commit(h, a, [{ id: itemId(1), baseVersion: 1, keyVersion: 1, ciphertext: cipher(10, 2) }]);
    const res = await commit(h, b, [{ id: itemId(1), baseVersion: 1, keyVersion: 1, ciphertext: cipher(10, 3) }]);
    expect(res.data.results[0].status).toBe("conflict");
    expect(res.data.results[0].current).toMatchObject({ version: 2, ciphertext: cipher(10, 2) });
    const created = await commit(h, b, [{ id: itemId(2), baseVersion: 3, keyVersion: 1, ciphertext: cipher(10) }]);
    expect(created.data.results[0]).toMatchObject({ status: "conflict", current: null });
  });

  it("pages changes by cursor in write order and only within a collection", async () => {
    const h = harness();
    const s = await ready(h);
    await commit(h, s, [1, 2, 3].map((n) => ({ id: itemId(n), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) })));
    await commit(h, s, [{ id: itemId(9), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) }], "history");
    await commit(h, s, [{ id: itemId(1), baseVersion: 1, keyVersion: 1, ciphertext: cipher(8, 9) }]);
    const first = await h.call("GET", "/v1/sync/bookmarks/changes?after=0&limit=2", { token: s.sessionToken });
    expect(first.data.items.map((i: any) => i.id)).toEqual([itemId(2), itemId(3)]);
    expect(first.data.more).toBe(true);
    const second = await h.call("GET", `/v1/sync/bookmarks/changes?after=${first.data.next}&limit=2`, { token: s.sessionToken });
    expect(second.data.items.map((i: any) => [i.id, i.version])).toEqual([[itemId(1), 2]]);
    expect(second.data.more).toBe(false);
    const history = await h.call("GET", "/v1/sync/history/changes", { token: s.sessionToken });
    expect(history.data.items.map((i: any) => i.id)).toEqual([itemId(9)]);
  });

  it("keeps deletions as tombstones without ciphertext", async () => {
    const h = harness();
    const s = await ready(h);
    await commit(h, s, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(30) }]);
    const res = await commit(h, s, [{ id: itemId(1), baseVersion: 1, deleted: true }]);
    expect(res.data.results[0]).toMatchObject({ status: "ok", version: 2 });
    const changes = await h.call("GET", "/v1/sync/bookmarks/changes", { token: s.sessionToken });
    expect(changes.data.items[0]).toMatchObject({ id: itemId(1), version: 2, deleted: true, size: 0 });
    expect(changes.data.items[0].ciphertext).toBeUndefined();
    expect((await h.call("GET", "/v1/sync/usage", { token: s.sessionToken })).data.bytesUsed).toBe(0);
  });

  it("stores large items in R2, serves them as bytes, and removes the old object on update", async () => {
    const h = harness();
    const s = await ready(h);
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    await commit(h, s, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: toBase64Url(big) }]);
    const changes = await h.call("GET", "/v1/sync/bookmarks/changes", { token: s.sessionToken });
    expect(changes.data.items[0]).toMatchObject({ blob: true, size: 200_000 });
    expect(changes.data.items[0].ciphertext).toBeUndefined();
    const res = await h.call("GET", `/v1/sync/bookmarks/items/${itemId(1)}/blob`, { token: s.sessionToken });
    expect(res.res.headers.get("perch-item-version")).toBe("1");
    expect(res.data).toEqual(big);
    const listed1 = await appEnv.BLOBS.list({ prefix: `items/${s.accountId}/` });
    expect(listed1.objects).toHaveLength(1);
    expect(listed1.objects[0]!.key.startsWith(`items/${s.accountId}/bookmarks/${itemId(1)}/1/`)).toBe(true);
    await commit(h, s, [{ id: itemId(1), baseVersion: 1, keyVersion: 1, ciphertext: toBase64Url(big.slice().reverse()) }]);
    const listed2 = await appEnv.BLOBS.list({ prefix: `items/${s.accountId}/` });
    expect(listed2.objects).toHaveLength(1);
    expect(listed2.objects[0]!.key.startsWith(`items/${s.accountId}/bookmarks/${itemId(1)}/2/`)).toBe(true);
  });

  it("keeps the winner's blob when two devices commit the same large item from the same base at once", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await ready(h, email);
    const b = await signIn(h, email);
    const first = new Uint8Array(100_000).fill(1);
    const second = new Uint8Array(100_000).fill(2);
    // Both writes reach R2 before either reaches D1: hold each put until the other arrives.
    let arrived = 0;
    let release!: () => void;
    const bothThere = new Promise<void>((resolve) => (release = resolve));
    const blobs = appEnv.BLOBS;
    const racing = { ...appEnv, BLOBS: { get: blobs.get.bind(blobs), delete: blobs.delete.bind(blobs), list: blobs.list.bind(blobs),
      put: async (key: string, value: Uint8Array) => {
        if (++arrived === 2) release();
        await bothThere;
        return blobs.put(key, value);
      } } } as typeof appEnv;
    const send = (s: Session, bytes: Uint8Array) => h.app.fetch(new Request("https://api.perchbrowser.com/v1/sync/bookmarks/commit", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.sessionToken}`, "cf-connecting-ip": h.ip },
      body: JSON.stringify({ items: [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: toBase64Url(bytes) }] }),
    }), racing).then(async (res) => ({ data: (await res.json()) as any }));
    const [ra, rb] = await Promise.all([send(a, first), send(b, second)]);
    const statuses = [ra.data.results[0].status, rb.data.results[0].status].sort();
    expect(statuses).toEqual(["conflict", "ok"]);
    const winner = ra.data.results[0].status === "ok" ? first : second;
    const res = await h.call("GET", `/v1/sync/bookmarks/items/${itemId(1)}/blob`, { token: a.sessionToken });
    expect(res.status).toBe(200);
    expect(res.data).toEqual(winner);
    const listed = await appEnv.BLOBS.list({ prefix: `items/${a.accountId}/` });
    expect(listed.objects).toHaveLength(1);
  });

  it("refuses writes with an old key version after a rotation", async () => {
    const h = harness();
    const s = await ready(h);
    await h.call("POST", "/v1/keys/rotate", { token: s.sessionToken, body: { version: 2, devices: { [s.deviceId]: `w${"B".repeat(30)}` } } });
    const res = await commit(h, s, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) }]);
    expect(res.data.results[0]).toEqual({ id: itemId(1), status: "stale_key", keyVersion: 2 });
  });

  it("enforces the storage quota and counts replaced items once", async () => {
    const h = harness();
    const s = await ready(h);
    const original = appEnv.QUOTA_BYTES;
    appEnv.QUOTA_BYTES = "1000";
    try {
      expect((await commit(h, s, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(600) }])).data.results[0].status).toBe("ok");
      expect((await commit(h, s, [{ id: itemId(1), baseVersion: 1, keyVersion: 1, ciphertext: cipher(900) }])).data.results[0].status).toBe("ok");
      expect((await commit(h, s, [{ id: itemId(2), baseVersion: 0, keyVersion: 1, ciphertext: cipher(200) }])).data.results[0].status).toBe("quota");
      const usage = await h.call("GET", "/v1/sync/usage", { token: s.sessionToken });
      expect(usage.data).toEqual({ bytesUsed: 900, quotaBytes: 1000, keyVersion: 1 });
    } finally {
      appEnv.QUOTA_BYTES = original;
    }
  });

  it("validates collections, ids and duplicates", async () => {
    const h = harness();
    const s = await ready(h);
    expect((await commit(h, s, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) }], "passwords")).status).toBe(400);
    expect((await commit(h, s, [{ id: "short", baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) }])).status).toBe(400);
    const dup = { id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) };
    expect((await commit(h, s, [dup, dup])).status).toBe(400);
    expect((await commit(h, s, [{ id: itemId(1), baseVersion: 0, deleted: true }])).status).toBe(400);
  });

  it("keeps accounts apart", async () => {
    const h = harness();
    const a = await ready(h);
    const b = await ready(h);
    await commit(h, a, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) }]);
    expect((await h.call("GET", "/v1/sync/bookmarks/changes", { token: b.sessionToken })).data.items).toEqual([]);
    expect((await commit(h, b, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) }])).data.results[0].status).toBe("ok");
  });

  it("purges old tombstones and tells devices behind them to resync", async () => {
    const h = harness();
    const s = await ready(h);
    await commit(h, s, [{ id: itemId(1), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) }]);
    await commit(h, s, [{ id: itemId(2), baseVersion: 0, keyVersion: 1, ciphertext: cipher(8) }]);
    await commit(h, s, [{ id: itemId(1), baseVersion: 1, deleted: true }]);
    // Age the tombstone past the 90-day window.
    await appEnv.DB.prepare("UPDATE items SET updated_at = ? WHERE account_id = ? AND deleted = 1").bind(h.clock.now - 91 * 24 * 60 * 60 * 1000, s.accountId).run();
    await cleanup(appEnv, h.clock.now);
    expect((await h.call("GET", "/v1/sync/bookmarks/changes?after=1", { token: s.sessionToken })).status).toBe(410);
    const fresh = await h.call("GET", "/v1/sync/bookmarks/changes?after=0", { token: s.sessionToken });
    expect(fresh.data.items.map((i: any) => i.id)).toEqual([itemId(2)]);
  });
});
