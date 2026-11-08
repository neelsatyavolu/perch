import { describe, expect, test } from "bun:test";
import { AUTHENTICATOR_OFF, browserVault } from "../../src/totp/stores";
import { Vault, type KeyStore, type RecordStore, type StoredEntry } from "../../src/totp/vault";

function memory(): { keys: KeyStore; records: RecordStore; stored: () => readonly StoredEntry[] } {
  let key: CryptoKey | null = null;
  let entries: readonly StoredEntry[] = [];
  return {
    keys: { get: async () => key, put: async (k) => void (key = k) },
    records: { read: async () => entries, write: async (e) => void (entries = e) },
    stored: () => entries,
  };
}

const account = {
  issuer: "Example",
  account: "alice@example.com",
  secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6,
  period: 30,
};

describe("Vault", () => {
  test("stores whole records encrypted: no secret, issuer or account name at rest", async () => {
    const m = memory();
    const vault = new Vault(m.keys, m.records);
    await vault.add(account, "example.com");
    const raw = JSON.stringify(m.stored());
    expect(raw).not.toContain(account.secret);
    expect(raw).not.toContain("alice");
    expect(raw).not.toContain("Example");
    expect(raw).not.toContain("example.com");
    const [entry] = await vault.list();
    expect(entry).toMatchObject({ ...account, site: "example.com" });
  });

  test("the key cannot be exported", async () => {
    const m = memory();
    await new Vault(m.keys, m.records).add(account, null);
    const key = (await m.keys.get())!;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  test("a changed or swapped record is refused, not misread", async () => {
    const m = memory();
    const vault = new Vault(m.keys, m.records);
    await vault.add(account, null);
    await vault.add({ ...account, account: "bob@example.com" }, null);
    const [a, b] = m.stored();
    await m.records.write([{ ...a!, data: b!.data, iv: b!.iv }, b!]);
    await expect(vault.list()).rejects.toThrow("could not be read");
  });

  test("rename and remove return new state without touching other records", async () => {
    const m = memory();
    const vault = new Vault(m.keys, m.records);
    const first = await vault.add(account, null);
    const second = await vault.add({ ...account, issuer: "Other" }, null);
    await vault.rename(first.id, { issuer: "Renamed", account: "alice" });
    await vault.remove(second.id);
    const list = await vault.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: first.id, issuer: "Renamed", account: "alice", secret: account.secret });
  });

  test("codes come from the stored secret", async () => {
    const m = memory();
    const vault = new Vault(m.keys, m.records);
    const entry = await vault.add({ ...account, secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }, null);
    expect(await vault.code(entry.id, 59)).toBe("287082");
  });

  test("a lost key is reported, never replaced while encrypted records remain", async () => {
    let key: CryptoKey | null = null;
    let puts = 0;
    let entries: readonly StoredEntry[] = [];
    const keys: KeyStore = { get: async () => key, put: async (k) => void ((key = k), puts++) };
    const records: RecordStore = { read: async () => entries, write: async (e) => void (entries = e) };
    const vault = new Vault(keys, records);
    await vault.add(account, null);
    key = null;
    await expect(vault.add({ ...account, account: "bob" }, null)).rejects.toThrow("could not be read");
    expect(puts).toBe(1);
    expect(key).toBeNull();
    expect(entries).toHaveLength(1);
  });
});

describe("browserVault", () => {
  const noPerchKey: KeyStore = { get: async () => Promise.reject(new Error("Specified native messaging host not found.")), put: async () => {} };
  const legacy = () => {
    const m = memory();
    return { ...m, legacy: { ...m.keys, remove: async () => {} } };
  };

  test("uses Perch's key when the browser answers, and moves records made under a development key", async () => {
    const m = legacy();
    await new Vault(m.legacy, m.records).add(account, "example.com");
    const perchKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const keys: KeyStore = { get: async () => perchKey, put: async () => {} };
    const open = await browserVault({ keys, legacy: m.legacy, records: m.records, unpacked: async () => true });
    expect(open!.keyInProfile).toBe(false);
    expect(await new Vault(keys, m.records).list()).toEqual(await open!.vault.list());
    expect((await open!.vault.list())[0]).toMatchObject({ ...account, site: "example.com" });
  });

  test("without Perch's key an unpacked (development) install keeps its key in the profile", async () => {
    const m = legacy();
    const open = await browserVault({ keys: noPerchKey, legacy: m.legacy, records: m.records, unpacked: async () => true });
    expect(open!.keyInProfile).toBe(true);
    await open!.vault.add(account, null);
    expect(await m.keys.get()).not.toBeNull();
  });

  test("without Perch's key any other install has no vault: the key would sit in the profile next to the records", async () => {
    const m = legacy();
    expect(await browserVault({ keys: noPerchKey, legacy: m.legacy, records: m.records, unpacked: async () => false })).toBeNull();
    expect(await browserVault({ keys: noPerchKey, legacy: m.legacy, records: m.records })).toBeNull();
    expect(AUTHENTICATOR_OFF).toContain("Perch's own key");
  });
});
