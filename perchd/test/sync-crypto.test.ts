import { describe, expect, test } from "bun:test";
import { decryptItem, deriveSyncKeys, encryptItem, itemId, newSyncKey } from "../src/sync/crypto";
import { base32, fromBase64Url, normalizeCode, pairingCode, toBase64Url } from "../src/sync/encoding";
import { exportDeviceKeys, generateDeviceKeys, importDeviceKeys, unwrapForDevice, wrapForDevice } from "../src/sync/keys";
import { createRecoveryKit, MIN_ITERATIONS, newRecoveryKey, openRecovery, recoveryBlob, recoveryKitFrom } from "../src/sync/recovery";

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
    const original = fromBase64Url(sealed);
    const tampered = original.map((byte, i) => (i === original.length - 1 ? byte ^ 1 : byte));
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
    const kit = await createRecoveryKit(recovery, MIN_ITERATIONS);
    const blob = await recoveryBlob(syncKey, 1, kit);
    expect(blob.length).toBeLessThan(4096);
    const opened = await openRecovery(blob, recovery.toLowerCase().replace(/-/g, " "), 1);
    expect(opened.syncKey).toEqual(syncKey);
    expect(opened.publicKey).toBe(kit.publicKey);
    await expect(openRecovery(blob, newRecoveryKey(), 1)).rejects.toThrow("does not open");
  });

  test("a rotation re-wraps for recovery without the recovery key, against the pinned public key", async () => {
    const recovery = newRecoveryKey();
    const kit = await createRecoveryKit(recovery, MIN_ITERATIONS);
    const first = await recoveryBlob(newSyncKey(), 1, kit);
    const rotated = newSyncKey();
    const second = await recoveryBlob(rotated, 2, recoveryKitFrom(first, kit.publicKey));
    expect((await openRecovery(second, recovery, 2)).syncKey).toEqual(rotated);
    const forged = await recoveryBlob(newSyncKey(), 1, await createRecoveryKit(newRecoveryKey(), MIN_ITERATIONS));
    expect(() => recoveryKitFrom(forged, kit.publicKey)).toThrow("does not match");
  });

  test("a chosen passphrase is case-sensitive and must be long enough", async () => {
    const kit = await createRecoveryKit("Correct horse battery staple", MIN_ITERATIONS);
    const blob = await recoveryBlob(newSyncKey(), 1, kit);
    await expect(openRecovery(blob, "correct horse battery staple", 1)).rejects.toThrow();
    await expect(createRecoveryKit("short", MIN_ITERATIONS)).rejects.toThrow("at least 12");
  });

  test("refuses weak PBKDF2 settings", async () => {
    await expect(createRecoveryKit("x".repeat(20), 1000)).rejects.toThrow("iterations");
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
