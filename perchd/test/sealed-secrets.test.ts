import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SealedSecrets } from "../src/secure/sealed-secrets";

const KEY = Buffer.alloc(32, 3);

async function temp(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "perch-sealed-")), "secrets", "config.sealed");
}

test("secrets round-trip through an owner-only file that holds no plain value", async () => {
  const path = await temp();
  const store = new SealedSecrets(path, KEY, "config");
  expect(await store.get("api-key:openai")).toBeNull();
  await store.set("api-key:openai", "sk-very-secret-value");
  expect(await store.get("api-key:openai")).toBe("sk-very-secret-value");
  expect((await readFile(path)).toString("latin1")).not.toContain("sk-very-secret");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await store.names()).toEqual(["api-key:openai"]);
  expect(await new SealedSecrets(path, KEY, "config").get("api-key:openai")).toBe("sk-very-secret-value");
});

test("add never replaces, and delete reports whether the item existed", async () => {
  const store = new SealedSecrets(await temp(), KEY, "secure");
  expect(await store.add("data-key", "one")).toBe(true);
  expect(await store.add("data-key", "two")).toBe(false);
  expect(await store.get("data-key")).toBe("one");
  expect(await store.delete("data-key")).toBe(true);
  expect(await store.delete("data-key")).toBe(false);
});

test("a different key or store label does not open the file", async () => {
  const path = await temp();
  await new SealedSecrets(path, KEY, "config").set("a", "b");
  await expect(new SealedSecrets(path, Buffer.alloc(32, 4), "config").get("a")).rejects.toThrow("could not be decrypted");
  await expect(new SealedSecrets(path, KEY, "sync").get("a")).rejects.toThrow("could not be decrypted");
});

test("marks are kept apart from secrets", async () => {
  const store = new SealedSecrets(await temp(), KEY, "daemon");
  expect(await store.marked("migrated-v1")).toBe(false);
  await store.mark("migrated-v1");
  expect(await store.marked("migrated-v1")).toBe(true);
  expect(await store.names()).toEqual([]);
});

test("concurrent writers in one process don't lose each other's items", async () => {
  const path = await temp();
  const a = new SealedSecrets(path, KEY, "config");
  const b = new SealedSecrets(path, KEY, "config");
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).set(`n${i}`, `v${i}`)));
  expect((await a.names()).length).toBe(10);
});

test("bad names and oversize values are refused", async () => {
  const store = new SealedSecrets(await temp(), KEY, "config");
  await expect(store.set("", "x")).rejects.toThrow("name");
  await expect(store.set("a\nb", "x")).rejects.toThrow("name");
  await expect(store.set("ok", "x".repeat(64 * 1024 + 1))).rejects.toThrow("64 KB");
});
