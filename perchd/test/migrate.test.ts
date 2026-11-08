import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKeychain as appKeychain } from "../src/app/keychain";
import { memoryKeychain as configKeychain } from "../src/config/keychain";
import { MemoryKeychain as DaemonKeychain } from "../src/daemon/keychain";
import { memoryKeychain as importKeychain } from "../src/import/keychain";
import { mockKeychain as memoryKeyStore } from "../src/memory/keychain";
import { MemoryKeychain as SecureKeychain } from "../src/secure/keychain";
import { memorySecretStore as syncStore } from "../src/sync/keychain";
import { KeySource, type KeyStoreName } from "../src/secure/key-channel";
import { migrateLegacy, type LegacyItem, type LegacySource } from "../src/secure/migrate";
import { SealedSecrets } from "../src/secure/sealed-secrets";

type Counter = { reads: number; removes: number };

function item(name: string, read: () => Promise<string | null>, remove: () => Promise<unknown>, count: Counter): LegacyItem {
  return {
    name,
    read: () => (count.reads++, read()),
    remove: async () => {
      count.removes++;
      await remove();
    },
  };
}

async function fixtures() {
  const app = appKeychain();
  await app.write("Perch Data Key", "Default", "a".repeat(43));
  const config = configKeychain();
  await config.set("settings-key", "c2V0dGluZ3M=");
  await config.set("api-key:openai", "sk-test-openai");
  const daemon = new DaemonKeychain();
  await daemon.set("claude-code", "t".repeat(43));
  const imports = importKeychain();
  await imports.set("Perch Import", "bundle-1", "aW1wb3J0");
  const memory = memoryKeyStore();
  await memory.set("data-key:Default", "bWVtb3J5");
  const sync = syncStore();
  await sync.set("session-token", "sess");
  const secure = new SecureKeychain();
  await secure.set("data-key", "c2VjdXJl");
  await secure.set("mcp/github/env/TOKEN", "ghp_x");
  const count: Counter = { reads: 0, removes: 0 };

  const sources: LegacySource[] = [
    { id: "app", store: "app", items: async () => [item("Perch Data Key/Default", () => app.read("Perch Data Key", "Default"), async () => undefined, count)] },
    { id: "config", store: "config", items: async () => config.names().map((n) => item(n, () => config.get(n), () => config.delete(n), count)) },
    { id: "daemon", store: "daemon", items: async () => [item("Perch clients/claude-code", () => daemon.get("claude-code"), () => daemon.delete("claude-code"), count)] },
    { id: "import", store: "import", items: async () => [item("Perch Import/bundle-1", () => imports.find("Perch Import", "bundle-1"), () => imports.remove("Perch Import", "bundle-1"), count)] },
    { id: "memory", store: "memory", items: async () => [...memory.accounts()].map((n) => item(n, () => memory.get(n), () => memory.delete(n), count)) },
    { id: "sync", store: "sync", items: async () => ["session-token", "device-keys"].map((n) => item(n, () => sync.get(n), () => sync.delete(n), count)) },
    { id: "secure", store: "secure", items: async () => secure.accounts().map((n) => item(n, () => secure.get(n), () => secure.delete(n), count)) },
  ];
  return { sources, count, config, secure, sync, memory, daemon };
}

async function targets() {
  const dir = await mkdtemp(join(tmpdir(), "perch-migrate-"));
  const source = new KeySource(Buffer.alloc(32, 9));
  const made = new Map<KeyStoreName, SealedSecrets>();
  return (store: KeyStoreName) => {
    const existing = made.get(store);
    if (existing) return existing;
    const s = new SealedSecrets(join(dir, `${store}.sealed`), source.derive(store), store);
    made.set(store, s);
    return s;
  };
}

test("every old store's items move into its sealed file, and the old items are deleted", async () => {
  const f = await fixtures();
  const target = await targets();
  const results = await migrateLegacy(f.sources, target);
  expect(results.map((r) => [r.id, r.moved])).toEqual([
    ["app", 1],
    ["config", 2],
    ["daemon", 1],
    ["import", 1],
    ["memory", 1],
    ["sync", 1],
    ["secure", 2],
  ]);
  expect(await target("config").get("api-key:openai")).toBe("sk-test-openai");
  expect(await target("secure").get("mcp/github/env/TOKEN")).toBe("ghp_x");
  expect(await target("daemon").get("Perch clients/claude-code")).toBe("t".repeat(43));
  expect(f.config.names()).toEqual([]);
  expect(f.secure.accounts()).toEqual([]);
  expect(await f.sync.get("session-token")).toBeNull();
  expect([...f.memory.accounts()]).toEqual([]);
});

test("a crash after store 3 resumes without copying stores 1 to 3 again", async () => {
  const f = await fixtures();
  const target = await targets();
  const crashing = f.sources.map((s, i) =>
    i === 3
      ? {
          ...s,
          items: async () => {
            throw new Error("power cut");
          },
        }
      : s,
  );
  await expect(migrateLegacy(crashing, target)).rejects.toThrow("moving the import secrets out of the Keychain stopped: power cut");
  const readsBefore = f.count.reads;
  expect(readsBefore).toBe(4);

  const again = await migrateLegacy(f.sources, target);
  expect(again.slice(0, 3).every((r) => r.skipped)).toBe(true);
  expect(again.slice(3).every((r) => !r.skipped)).toBe(true);
  // Only stores 4 to 7 were read the second time: 1 + 1 + 2 + 2 items.
  expect(f.count.reads - readsBefore).toBe(6);

  const third = await migrateLegacy(f.sources, target);
  expect(third.every((r) => r.skipped)).toBe(true);
});

test("a crash between copying and deleting finishes the deletes without copying again", async () => {
  const f = await fixtures();
  const target = await targets();
  let fail = true;
  const flaky: LegacySource = {
    ...f.sources[1]!,
    items: async () =>
      (await f.sources[1]!.items()).map((it) => ({
        ...it,
        remove: async () => {
          if (fail) throw new Error("killed");
          await it.remove();
        },
      })),
  };
  await expect(migrateLegacy([flaky], target)).rejects.toThrow("killed");
  expect(f.config.names().length).toBe(2);
  fail = false;
  const reads = f.count.reads;
  const [result] = await migrateLegacy([flaky], target);
  expect(result!.moved).toBe(0);
  expect(f.count.reads).toBe(reads);
  expect(f.config.names()).toEqual([]);
});

test("an item the new store already holds is never replaced by the old value", async () => {
  const f = await fixtures();
  const target = await targets();
  await target("config").set("api-key:openai", "sk-newer");
  await migrateLegacy(f.sources, target);
  expect(await target("config").get("api-key:openai")).toBe("sk-newer");
});

test("the error from a failed store never carries a secret value", async () => {
  const f = await fixtures();
  const target = await targets();
  const leaky: LegacySource = { id: "config", store: "config", items: async () => [item("x", async () => "sk-test-openai", async () => Promise.reject(new Error("denied")), f.count)] };
  const error = await migrateLegacy([leaky], target).catch((e: Error) => e);
  expect((error as Error).message).not.toContain("sk-test-openai");
});
