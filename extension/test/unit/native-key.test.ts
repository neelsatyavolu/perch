import { describe, expect, test } from "bun:test";
import { KEYS_HOST, nativeKeyStore, type SendNative } from "../../src/totp/native-key";
import { Vault, type RecordStore, type StoredEntry } from "../../src/totp/vault";

const KEY = new Uint8Array(32).map((_, i) => i + 1);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function fake(reply: () => Promise<unknown>): { send: SendNative; calls: { host: string; message: object }[] } {
  const calls: { host: string; message: object }[] = [];
  return { calls, send: (host, message) => (calls.push({ host, message }), reply()) };
}

const account = { issuer: "Example", account: "alice", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };

describe("nativeKeyStore", () => {
  test("asks Perch's keys host for the authenticator key and imports a usable, non-extractable AES-GCM key", async () => {
    const { send, calls } = fake(async () => ({ key: b64(KEY) }));
    const key = await nativeKeyStore(send).get();
    expect(calls).toEqual([{ host: KEYS_HOST, message: { op: "authenticator" } }]);
    expect(KEYS_HOST).toBe("co.xanom.perch.keys");
    expect(key!.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key!.extractable).toBe(false);
    expect(key!.usages.toSorted()).toEqual(["decrypt", "encrypt"]);
  });

  test("keeps the key in memory: one native call for many reads", async () => {
    const { send, calls } = fake(async () => ({ key: b64(KEY) }));
    const store = nativeKeyStore(send);
    const [a, b] = await Promise.all([store.get(), store.get()]);
    expect(await store.get()).toBe(a!);
    expect(b).toBe(a!);
    expect(calls).toHaveLength(1);
  });

  test("the same bytes give the same key, so records survive a restart", async () => {
    const records = memoryRecords();
    const first = new Vault(nativeKeyStore(async () => ({ key: b64(KEY) })), records);
    await first.add(account, "example.com");
    const second = new Vault(nativeKeyStore(async () => ({ key: b64(KEY) })), records);
    expect((await second.list())[0]).toMatchObject({ ...account, site: "example.com" });
  });

  test("zero-fills the decoded key bytes after import", async () => {
    const seen: Uint8Array[] = [];
    const realImport = crypto.subtle.importKey.bind(crypto.subtle);
    const spy = ((format: "raw", data: Uint8Array, ...rest: unknown[]) => {
      seen.push(data);
      return (realImport as (...a: unknown[]) => Promise<CryptoKey>)(format, data, ...rest);
    }) as typeof crypto.subtle.importKey;
    crypto.subtle.importKey = spy;
    try {
      await nativeKeyStore(async () => ({ key: b64(KEY) })).get();
    } finally {
      crypto.subtle.importKey = realImport;
    }
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].every((b) => b === 0)).toBe(true);
  });

  test("put is a no-op: the browser owns the key", async () => {
    const { send, calls } = fake(async () => ({ key: b64(KEY) }));
    const generated = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await nativeKeyStore(send).put(generated);
    expect(calls).toHaveLength(0);
  });

  const bad: [string, () => Promise<unknown>][] = [
    ["a key of the wrong length", async () => ({ key: b64(new Uint8Array(16)) })],
    ["a key that is not base64", async () => ({ key: "not base64!" })],
    ["no answer", async () => undefined],
    ["an answer without a key", async () => ({ error: "nope" })],
    ["an error from the host (lastError)", async () => Promise.reject(new Error("Specified native messaging host not found."))],
  ];
  for (const [name, reply] of bad) {
    test(`throws, never returns null, on ${name}`, async () => {
      // null would let the Vault make a random key that put() then drops, losing every later record.
      await expect(nativeKeyStore(reply).get()).rejects.toThrow("Perch did not provide the authenticator key");
    });
  }

  test("a failed read is not cached: the next read asks again", async () => {
    let answer: unknown = undefined;
    const store = nativeKeyStore(async () => answer);
    await expect(store.get()).rejects.toThrow();
    answer = { key: b64(KEY) };
    expect(await store.get()).not.toBeNull();
  });

  test("error messages never carry the reply", async () => {
    const secretish = b64(new Uint8Array(31).fill(7));
    const error = await nativeKeyStore(async () => ({ key: secretish })).get().catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain(secretish);
  });
});

function memoryRecords(): RecordStore {
  let entries: readonly StoredEntry[] = [];
  return { read: async () => entries, write: async (e) => void (entries = e) };
}
