import { describe, expect, test } from "bun:test";
import { migrateKey, type LegacyKeyStore } from "../../src/totp/migrate-key";
import { Vault, type KeyStore, type RecordStore, type StoredEntry } from "../../src/totp/vault";

const account = { issuer: "Example", account: "alice", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };
const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

function setup() {
  let entries: readonly StoredEntry[] = [];
  let old: CryptoKey | null = null;
  let removed = 0;
  let writes = 0;
  const records: RecordStore = { read: async () => entries, write: async (e) => void ((entries = e), writes++) };
  const legacy: LegacyKeyStore & KeyStore = {
    get: async () => old,
    put: async (k) => void (old = k),
    remove: async () => void ((old = null), removed++),
  };
  return {
    records,
    legacy,
    stored: () => entries,
    setStored: (e: readonly StoredEntry[]) => void (entries = e),
    removed: () => removed,
    writes: () => writes,
  };
}

async function nativeStore(): Promise<KeyStore> {
  const key = await newKey();
  return { get: async () => key, put: async () => {} };
}

describe("migrateKey", () => {
  test("re-encrypts records made under the IndexedDB key with Perch's key, then deletes the old key", async () => {
    const s = setup();
    const dev = new Vault(s.legacy, s.records);
    await dev.add(account, "example.com");
    await dev.add({ ...account, account: "bob" }, null);
    const before = await dev.list();
    const native = await nativeStore();

    expect(await migrateKey(s.legacy, native, s.records)).toBe(2);
    expect(s.removed()).toBe(1);
    expect(await s.legacy.get()).toBeNull();
    expect(await new Vault(native, s.records).list()).toEqual(before);
  });

  test("does nothing without an old key", async () => {
    const s = setup();
    expect(await migrateKey(s.legacy, await nativeStore(), s.records)).toBe(0);
    expect(s.writes()).toBe(0);
    expect(s.removed()).toBe(0);
  });

  test("is idempotent: running again after a crash between write and delete moves nothing twice", async () => {
    const s = setup();
    await new Vault(s.legacy, s.records).add(account, null);
    const native = await nativeStore();
    const oldKey = (await s.legacy.get())!;
    // Crash after the write: records are already under the native key, the old key is still there.
    const failingDelete = { ...s.legacy, remove: async () => Promise.reject(new Error("crash")) };
    await expect(migrateKey(failingDelete, native, s.records)).rejects.toThrow("crash");
    expect(await s.legacy.get()).toBe(oldKey);
    const afterCrash = s.stored();

    expect(await migrateKey(s.legacy, native, s.records)).toBe(0);
    expect(s.stored()).toEqual(afterCrash);
    expect(s.removed()).toBe(1);
    expect((await new Vault(native, s.records).list())[0]).toMatchObject(account);
  });

  test("handles a mix of migrated and unmigrated records", async () => {
    const s = setup();
    const native = await nativeStore();
    await new Vault(s.legacy, s.records).add(account, null);
    const legacyRecords = s.stored();
    s.setStored([]);
    await new Vault(native, s.records).add({ ...account, account: "bob" }, null);
    s.setStored([...legacyRecords, ...s.stored()]);

    expect(await migrateKey(s.legacy, native, s.records)).toBe(1);
    expect((await new Vault(native, s.records).list()).map((e) => e.account)).toEqual(["alice", "bob"]);
  });

  test("a record neither key opens stops the move: nothing written, old key kept", async () => {
    const s = setup();
    await new Vault(s.legacy, s.records).add(account, null);
    const stranger = setup();
    await new Vault(stranger.legacy, stranger.records).add(account, null);
    const before = [...s.stored(), ...stranger.stored()];
    s.setStored(before);
    const writes = s.writes();

    await expect(migrateKey(s.legacy, await nativeStore(), s.records)).rejects.toThrow("could not be read");
    expect(s.stored()).toEqual(before);
    expect(s.writes()).toBe(writes);
    expect(s.removed()).toBe(0);
    expect(await s.legacy.get()).not.toBeNull();
  });

  test("a failed write keeps the old key", async () => {
    const s = setup();
    await new Vault(s.legacy, s.records).add(account, null);
    const before = s.stored();
    const failing: RecordStore = { read: s.records.read, write: async () => Promise.reject(new Error("disk full")) };
    await expect(migrateKey(s.legacy, await nativeStore(), failing)).rejects.toThrow("disk full");
    expect(s.removed()).toBe(0);
    expect(s.stored()).toEqual(before);
  });
});
