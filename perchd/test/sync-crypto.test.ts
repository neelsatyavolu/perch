import { describe, expect, test } from "bun:test";
import { decryptItem, deriveSyncKeys, encryptItem, itemId, newSyncKey } from "../src/sync/crypto";
import { base32, fromBase64Url, normalizeCode, toBase64Url } from "../src/sync/encoding";
import { decodeKeys, encodeKeys, exportDeviceKeys, generateDeviceKeys, importDeviceKeys, unwrapForDevice, wrapForDevice } from "../src/sync/keys";
import { commitment, keyMatchesCode, newPairingCode, openGrant, pairingQrPayload, parsePairingCode, sealGrant } from "../src/sync/pairing";
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
    const keys = [{ version: 1, raw: newSyncKey() }];
    const recovery = newRecoveryKey();
    expect(recovery).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/);
    const kit = await createRecoveryKit(recovery, MIN_ITERATIONS);
    const blob = await recoveryBlob(keys, kit);
    expect(blob.length).toBeLessThan(4096);
    const opened = await openRecovery(blob, recovery.toLowerCase().replace(/-/g, " "), 1);
    expect(opened.keys).toEqual(keys);
    expect(opened.publicKey).toBe(kit.publicKey);
    await expect(openRecovery(blob, newRecoveryKey(), 1)).rejects.toThrow("does not open");
  });

  test("a rotation re-wraps for recovery without the recovery key, against the pinned public key", async () => {
    const recovery = newRecoveryKey();
    const kit = await createRecoveryKit(recovery, MIN_ITERATIONS);
    const v1 = { version: 1, raw: newSyncKey() };
    const first = await recoveryBlob([v1], kit);
    const both = [v1, { version: 2, raw: newSyncKey() }];
    const second = await recoveryBlob(both, recoveryKitFrom(first, kit.publicKey));
    // The recovery copy keeps the old version too, so items from before the rotation stay readable.
    expect((await openRecovery(second, recovery, 2)).keys).toEqual(both);
    await expect(openRecovery(second, recovery, 1)).rejects.toThrow();
    const forged = await recoveryBlob([{ version: 1, raw: newSyncKey() }], await createRecoveryKit(newRecoveryKey(), MIN_ITERATIONS));
    expect(() => recoveryKitFrom(forged, kit.publicKey)).toThrow("does not match");
  });

  test("a chosen passphrase is case-sensitive and must be long enough", async () => {
    const kit = await createRecoveryKit("Correct horse battery staple", MIN_ITERATIONS);
    const blob = await recoveryBlob([{ version: 1, raw: newSyncKey() }], kit);
    await expect(openRecovery(blob, "correct horse battery staple", 1)).rejects.toThrow();
    await expect(createRecoveryKit("short", MIN_ITERATIONS)).rejects.toThrow("at least 12");
  });

  test("refuses weak PBKDF2 settings", async () => {
    await expect(createRecoveryKit("x".repeat(20), 1000)).rejects.toThrow("iterations");
  });
});

describe("key payloads", () => {
  test("carry every version and refuse a payload whose newest key is not the wrap's version", () => {
    const keys = [{ version: 1, raw: newSyncKey() }, { version: 2, raw: newSyncKey() }];
    expect(decodeKeys(encodeKeys(keys), 2)).toEqual(keys);
    expect(() => decodeKeys(encodeKeys(keys), 1)).toThrow("does not match");
    expect(() => decodeKeys(new Uint8Array(32), 1)).toThrow("format");
  });
});

describe("pairing codes and grants", () => {
  test("a code is a commitment to the key and a secret, then the secret", async () => {
    const keys = await generateDeviceKeys();
    const code = await newPairingCode(keys.publicKey);
    expect(code.display).toMatch(/^([0-9A-Z]{4}-){3}[0-9A-Z]{4}$/);
    expect(code.lookup).toBe(await commitment(keys.publicKey, code.secret));
    expect(normalizeCode(code.lookup.toLowerCase().replace("-", " "))).toBe(code.lookup);
    const typed = parsePairingCode(code.display.toLowerCase().replace(/-/g, " ").replace(/0/g, "o"));
    expect(typed).toEqual({ lookup: code.lookup, secret: code.secret });
    expect(parsePairingCode(pairingQrPayload(code))).toEqual(typed);
    expect(await keyMatchesCode(keys.publicKey, typed)).toBe(true);
    expect(await keyMatchesCode((await generateDeviceKeys()).publicKey, typed)).toBe(false);
    expect(() => parsePairingCode("ABCD-EFGH")).toThrow("16 letters");
    expect(base32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), 8)).toBe("ZZZZZZZZ");
    expect(base32(new Uint8Array([0, 0, 0, 0, 0x21]), 8)).toBe("00000011");
  });

  test("a grant opens only with the device key, the code's secret and the same pairing", async () => {
    const device = await generateDeviceKeys();
    const approver = await generateDeviceKeys();
    const recovery = await generateDeviceKeys();
    const keys = [{ version: 1, raw: newSyncKey() }, { version: 2, raw: newSyncKey() }];
    const grant = { approver: { id: "dev_mac", publicKey: approver.publicKey }, recoveryPublicKey: recovery.publicKey, keys };
    const blob = await sealGrant(grant, device.publicKey, "ABCDEFGH", "pair_1");
    expect(await openGrant(blob, device, "ABCDEFGH", "pair_1")).toEqual(grant);
    await expect(openGrant(blob, device, "ABCDEFGJ", "pair_1")).rejects.toThrow("could not be verified");
    await expect(openGrant(blob, device, "ABCDEFGH", "pair_2")).rejects.toThrow("could not be verified");
    await expect(openGrant(blob, approver, "ABCDEFGH", "pair_1")).rejects.toThrow("could not be verified");
    // A server that knows the device's public key but not the secret cannot forge one.
    const forged = await sealGrant({ approver: { id: "dev_mac", publicKey: (await generateDeviceKeys()).publicKey } }, device.publicKey, "ZZZZZZZZ", "pair_1");
    await expect(openGrant(forged, device, "ABCDEFGH", "pair_1")).rejects.toThrow("could not be verified");
  });
});
