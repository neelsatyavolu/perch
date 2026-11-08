import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { browserSecrets } from "../src/cli/browser-keys";
import { memoryKeychain as configKeychain } from "../src/config/keychain";
import { readKeyChannel } from "../src/secure/key-channel";
import type { LegacySource } from "../src/secure/migrate";

const ROOT = Buffer.alloc(32, 5).toString("base64");

async function setup(line?: Record<string, unknown>) {
  const dataDir = await mkdtemp(join(tmpdir(), "perch-keys-"));
  const dir = join(dataDir, "Default");
  const stream = new PassThrough();
  const channel = readKeyChannel(stream);
  if (line) stream.write(`${JSON.stringify({ op: "profile", id: "Default", dir, key: ROOT, protected: true, ...line })}\n`);
  const old = configKeychain();
  await old.set("api-key:openai", "sk-from-keychain");
  const sources: LegacySource[] = [{ id: "config", store: "config", items: async () => old.names().map((n) => ({ name: n, read: () => old.get(n), remove: async () => void (await old.delete(n)) })) }];
  const log: string[] = [];
  return { dataDir, dir, stream, channel, old, sources, log };
}

test("with the browser's key, secrets move into sealed files under the profile and the stores use them", async () => {
  const s = await setup({ recovery: Buffer.alloc(100, 2).toString("base64") });
  const secrets = await browserSecrets(s.channel, { profile: "Default", dataDir: s.dataDir, clientsFile: "/nonexistent", log: (l) => s.log.push(l), sources: s.sources, waitMs: 500 });
  expect(secrets).not.toBeNull();
  expect(await secrets!.config().get("api-key:openai")).toBe("sk-from-keychain");
  expect(s.old.names()).toEqual([]);
  expect(await readdir(join(s.dir, "Perch Agent", "secrets"))).toContain("config.sealed");
  const recovery = join(s.dir, "Perch Agent", "root.recovery");
  expect((await readFile(recovery)).length).toBe(100);
  expect((await stat(recovery)).mode & 0o777).toBe(0o600);
  expect(s.log.join("")).not.toContain("sk-from-keychain");
  expect(s.log.join("")).not.toContain(ROOT);
  s.stream.end();
});

test("the recovery copy is written once and never replaced", async () => {
  const s = await setup({ recovery: Buffer.alloc(100, 2).toString("base64") });
  await browserSecrets(s.channel, { profile: "Default", dataDir: s.dataDir, clientsFile: "/x", log: () => {}, sources: [], waitMs: 500 });
  s.stream.write(`${JSON.stringify({ op: "profile", id: "Default", dir: s.dir, key: ROOT, protected: true, recovery: Buffer.alloc(100, 9).toString("base64") })}\n`);
  await Bun.sleep(5);
  await browserSecrets(s.channel, { profile: "Default", dataDir: s.dataDir, clientsFile: "/x", log: () => {}, sources: [], waitMs: 500 });
  expect((await readFile(join(s.dir, "Perch Agent", "root.recovery")))[0]).toBe(2);
  s.stream.end();
});

test("without a key from the browser, perchd keeps the Keychain and moves nothing", async () => {
  const s = await setup();
  const secrets = await browserSecrets(s.channel, { profile: "Default", dataDir: s.dataDir, clientsFile: "/x", log: (l) => s.log.push(l), sources: s.sources, waitMs: 10 });
  expect(secrets).toBeNull();
  expect(s.old.names()).toEqual(["api-key:openai"]);
  expect(s.log.join("")).toContain("no profile key");
  s.stream.end();
});

test("an unprotected key (a development build) is said so in the log", async () => {
  const s = await setup({ protected: false });
  await browserSecrets(s.channel, { profile: "Default", dataDir: s.dataDir, clientsFile: "/x", log: (l) => s.log.push(l), sources: [], waitMs: 500 });
  expect(s.log.join("")).toContain("not protected by the Secure Enclave");
  s.stream.end();
});

test("a failed move is logged and perchd still opens the sealed stores", async () => {
  const s = await setup({});
  const broken: LegacySource[] = [{ id: "config", store: "config", items: async () => Promise.reject(new Error("locked")) }];
  const secrets = await browserSecrets(s.channel, { profile: "Default", dataDir: s.dataDir, clientsFile: "/x", log: (l) => s.log.push(l), sources: broken, waitMs: 500 });
  expect(secrets).not.toBeNull();
  expect(s.log.join("")).toContain("stopped: locked");
  s.stream.end();
});
