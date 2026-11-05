import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacKeychain, MemoryKeychain, type SecretStore } from "../src/secure/keychain";
import { createKeychain } from "../src/secure/mac-security";
import { dataKey, openSealed, readSealedJson, seal, writeSealedJson } from "../src/secure/sealed";

const dir = mkdtempSync(join(tmpdir(), "perch-secure-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FAKE = "sk-test-not-a-real-key-123";

test("the memory keychain stores, reads and deletes", async () => {
  const kc = new MemoryKeychain();
  expect(await kc.get("mcp/a/env/KEY")).toBeNull();
  await kc.set("mcp/a/env/KEY", FAKE);
  expect(await kc.get("mcp/a/env/KEY")).toBe(FAKE);
  await kc.delete("mcp/a/env/KEY");
  expect(await kc.get("mcp/a/env/KEY")).toBeNull();
});

const darwin = process.platform === "darwin";
const keychainList = () => Bun.spawnSync(["/usr/bin/security", "list-keychains", "-d", "user"]).stdout.toString();

/** A throwaway keychain file: never the login keychain, and never added to the search list. */
function withKeychain(run: (kc: MacKeychain, path: string) => Promise<void>) {
  return async () => {
    const path = join(dir, `t-${Math.random().toString(36).slice(2)}.keychain-db`);
    const file = createKeychain(path, "throwaway-test-password");
    try {
      await run(new MacKeychain({ service: "PerchTest", keychain: file.ref }), path);
    } finally {
      file.destroy();
    }
  };
}

test.skipIf(!darwin)("the Keychain stores, replaces, adds only when missing and deletes", withKeychain(async (kc) => {
  const before = keychainList();
  expect(await kc.get("mcp/a/env/KEY")).toBeNull();
  await kc.set("mcp/a/env/KEY", 'päss "word" \n');
  expect(await kc.get("mcp/a/env/KEY")).toBe('päss "word" \n');
  await kc.set("mcp/a/env/KEY", FAKE);
  expect(await kc.get("mcp/a/env/KEY")).toBe(FAKE);
  expect(await kc.add("mcp/a/env/KEY", "other")).toBe(false);
  expect(await kc.get("mcp/a/env/KEY")).toBe(FAKE);
  expect(await kc.add("mcp/b/env/KEY", "new")).toBe(true);
  expect(await kc.get("mcp/b/env/KEY")).toBe("new");
  await kc.delete("mcp/a/env/KEY");
  await kc.delete("mcp/a/env/KEY");
  expect(await kc.get("mcp/a/env/KEY")).toBeNull();
  expect(keychainList()).toBe(before);
}));

test.skipIf(!darwin)("only the program running Perch may read a Keychain item, not /usr/bin/security", withKeychain(async (kc, path) => {
  await kc.set("mcp/a/env/KEY", FAKE);
  // dump-keychain -a lists access lists without decrypting anything, so it never prompts.
  const dump = Bun.spawnSync(["/usr/bin/security", "dump-keychain", "-a", path], { timeout: 10_000 }).stdout.toString();
  expect(dump).not.toContain(FAKE);
  const entries = dump.split(/\n\s*entry \d+:\n/).slice(1);
  const decrypt = entries.find((e) => /authorizations \(\d+\):.*\bdecrypt\b/.test(e));
  expect(decrypt).toBeDefined();
  const apps = [...decrypt!.matchAll(/^\s+\d+: (\S+)/gm)].map((m) => m[1]);
  expect(apps).toEqual([process.execPath]);
  expect(decrypt).not.toContain("applications: <null>");
}));

test("Keychain account names are checked before they reach the Keychain", async () => {
  const kc = new MacKeychain();
  await expect(kc.set('a" -w "evil', FAKE)).rejects.toThrow("not a valid Keychain account name");
  await expect(kc.get("a\nb")).rejects.toThrow("not a valid Keychain account name");
  await expect(kc.add("", FAKE)).rejects.toThrow("not a valid Keychain account name");
});

/** A keychain where reads and writes take turns with other callers, like two processes would. */
class SlowKeychain extends MemoryKeychain {
  sets = 0;
  override async get(account: string) {
    await Bun.sleep(5);
    return super.get(account);
  }
  override async set(account: string, value: string) {
    this.sets++;
    await Bun.sleep(5);
    return super.set(account, value);
  }
  override async add(account: string, value: string) {
    await Bun.sleep(5);
    return super.add(account, value);
  }
}

test("two first uses of the data key at once agree on one key", async () => {
  const kc = new SlowKeychain();
  const [a, b] = await Promise.all([dataKey(kc), dataKey(kc)]);
  expect(a.equals(b)).toBe(true);
  expect(kc.sets).toBe(0);
});

test("a data key made by another process first is used, not replaced", async () => {
  const shared = new SlowKeychain();
  // Two stores over one keychain stand in for two processes: no shared in-process cache.
  const other: SecretStore = {
    get: (a) => shared.get(a),
    set: (a, v) => shared.set(a, v),
    add: (a, v) => shared.add(a, v),
    delete: (a) => shared.delete(a),
  };
  const [mine, theirs] = await Promise.all([dataKey(shared), dataKey(other)]);
  expect(mine.equals(theirs)).toBe(true);
  expect(Buffer.from((await shared.get("data-key"))!, "base64").equals(mine)).toBe(true);
  expect(shared.sets).toBe(0);
});

test("sealed data round-trips and fails on a wrong key, a wrong label or tampering", async () => {
  const kc = new MemoryKeychain();
  const key = await dataKey(kc);
  expect(key.length).toBe(32);
  expect((await dataKey(kc)).equals(key)).toBe(true);
  const blob = seal(key, "hello", "mcp-servers");
  expect(blob.toString("utf8")).not.toContain("hello");
  expect(openSealed(key, blob, "mcp-servers")).toBe("hello");
  expect(() => openSealed(key, blob, "skills")).toThrow();
  expect(() => openSealed(Buffer.alloc(32, 1), blob, "mcp-servers")).toThrow();
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1]! ^= 1;
  expect(() => openSealed(key, tampered, "mcp-servers")).toThrow();
});

test("sealed JSON files are owner-only and unreadable without the key", async () => {
  const key = await dataKey(new MemoryKeychain());
  const path = join(dir, "sub", "servers.enc");
  expect(await readSealedJson(path, key, "t")).toBeNull();
  await writeSealedJson(path, key, "t", { name: "github", url: "https://example.test/mcp" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
  expect(readFileSync(path).toString("latin1")).not.toContain("github");
  expect(await readSealedJson<object>(path, key, "t")).toEqual({ name: "github", url: "https://example.test/mcp" });
  writeFileSync(path, "garbage");
  await expect(readSealedJson(path, key, "t")).rejects.toThrow("could not be decrypted");
});
