import { describe, expect, test } from "bun:test";
import { decryptItem, deriveSyncKeys, encryptItem, itemId, newSyncKey } from "../src/sync/crypto";
import { base32, fromBase64Url, normalizeCode, pairingCode, toBase64Url } from "../src/sync/encoding";
import {
  exportDeviceKeys, generateDeviceKeys, importDeviceKeys, MIN_ITERATIONS, newRecoveryKey,
  unwrapForDevice, unwrapWithRecovery, wrapForDevice, wrapWithRecovery,
} from "../src/sync/keys";

describe("item encryption", () => {
  test("round-trips and never puts the plaintext or real id in what the server sees", async () => {
    const keys = await deriveSyncKeys(newSyncKey(), 1);
    const id = await itemId(keys, "history", "https://bank.example/statements");
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(id).toBe(await itemId(keys, "history", "https://bank.example/statements"));
    expect(id).not.toBe(await itemId(keys, "bookmarks", "https://bank.example/statements"));
    const sealed = await encryptItem(keys, "history", id, 1, '{"title":"Statements"}');
    expect(atob(sealed.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("Statements");
    expect(await decryptItem(keys, "history", id, 1, sealed)).toBe('{"title":"Statements"}');
  });

  test("refuses a ciphertext moved to another item, collection, version or key", async () => {
    const raw = newSyncKey();
    const keys = await deriveSyncKeys(raw, 1);
    const sealed = await encryptItem(keys, "bookmarks", "item-a", 3, "x");
    await expect(decryptItem(keys, "bookmarks", "item-b", 3, sealed)).rejects.toThrow();
    await expect(decryptItem(keys, "settings", "item-a", 3, sealed)).rejects.toThrow();
    await expect(decryptItem(keys, "bookmarks", "item-a", 2, sealed)).rejects.toThrow();
    await expect(decryptItem(await deriveSyncKeys(raw, 2), "bookmarks", "item-a", 3, sealed)).rejects.toThrow();
    await expect(decryptItem(await deriveSyncKeys(newSyncKey(), 1), "bookmarks", "item-a", 3, sealed)).rejects.toThrow();
    const tampered = fromBase64Url(sealed);
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptItem(keys, "bookmarks", "item-a", 3, toBase64Url(tampered))).rejects.toThrow();
  });
});

describe("key wrapping", () => {
  test("only the named device opens its copy", async () => {
    const syncKey = newSyncKey();
    const mac = await generateDeviceKeys();
    const other = await generateDeviceKeys();
    const blob = await wrapForDevice(syncKey, mac.publicKey, "dev_mac", 2);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await unwrapForDevice(blob, mac, "dev_mac", 2)).toEqual(syncKey);
    await expect(unwrapForDevice(blob, other, "dev_mac", 2)).rejects.toThrow();
    await expect(unwrapForDevice(blob, mac, "dev_other", 2)).rejects.toThrow();
    await expect(unwrapForDevice(blob, mac, "dev_mac", 3)).rejects.toThrow();
  });

  test("device keys survive a trip through the Keychain format", async () => {
    const keys = await generateDeviceKeys();
    const restored = await importDeviceKeys(await exportDeviceKeys(keys));
    const blob = await wrapForDevice(newSyncKey(), keys.publicKey, "dev_a", 1);
    expect((await unwrapForDevice(blob, restored, "dev_a", 1)).length).toBe(32);
  });

  test("the recovery key opens the recovery copy however it is typed", async () => {
    const syncKey = newSyncKey();
    const recovery = newRecoveryKey();
    expect(recovery).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/);
    const blob = await wrapWithRecovery(syncKey, recovery, 1, MIN_ITERATIONS);
    expect(await unwrapWithRecovery(blob, recovery.toLowerCase().replace(/-/g, " "), 1)).toEqual(syncKey);
    await expect(unwrapWithRecovery(blob, newRecoveryKey(), 1)).rejects.toThrow("does not open");
  });

  test("a chosen passphrase is case-sensitive", async () => {
    const blob = await wrapWithRecovery(newSyncKey(), "Correct horse battery staple", 1, MIN_ITERATIONS);
    await expect(unwrapWithRecovery(blob, "correct horse battery staple", 1)).rejects.toThrow();
  });

  test("refuses weak PBKDF2 settings", async () => {
    await expect(wrapWithRecovery(newSyncKey(), "x".repeat(20), 1, 1000)).rejects.toThrow("at least");
  });
});

describe("codes", () => {
  test("pairing codes are the first 40 bits of the key hash", async () => {
    const keys = await generateDeviceKeys();
    const code = await pairingCode(keys.publicKey);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(normalizeCode(code.toLowerCase().replace("-", " "))).toBe(code);
    expect(base32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), 8)).toBe("ZZZZZZZZ");
    expect(base32(new Uint8Array([0, 0, 0, 0, 0x21]), 8)).toBe("00000011");
  });
});
