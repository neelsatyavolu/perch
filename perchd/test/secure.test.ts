import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacKeychain, MemoryKeychain, type Runner } from "../src/secure/keychain";
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

function recorder(reply: { code: number; stdout: string } = { code: 0, stdout: "" }) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const run: Runner = async (args, stdin) => {
    calls.push({ args, stdin });
    return { ...reply, stderr: "" };
  };
  return { calls, run };
}

test("a Keychain write never puts the secret in the process arguments", async () => {
  const { calls, run } = recorder();
  await new MacKeychain({ service: "Perch", run }).set("mcp/a/env/KEY", FAKE);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual(["-i"]);
  expect(calls[0]!.args.join(" ")).not.toContain(FAKE);
  // The value goes in as hex on stdin, so quotes and spaces in a secret cannot break the command.
  const hex = Buffer.from(Buffer.from(FAKE, "utf8").toString("base64"), "utf8").toString("hex");
  expect(calls[0]!.stdin).toBe(`add-generic-password -U -s "Perch" -a "mcp/a/env/KEY" -X ${hex}\n`);
});

test("a Keychain read decodes the stored value and treats exit 44 as missing", async () => {
  const stored = Buffer.from("päss \"word\"", "utf8").toString("base64");
  const found = recorder({ code: 0, stdout: `${stored}\n` });
  expect(await new MacKeychain({ run: found.run }).get("x")).toBe("päss \"word\"");
  expect(found.calls[0]!.args).toEqual(["find-generic-password", "-s", "Perch", "-a", "x", "-w"]);
  const missing = recorder({ code: 44, stdout: "" });
  expect(await new MacKeychain({ run: missing.run }).get("x")).toBeNull();
});

test("Keychain account names are checked before they reach the command", async () => {
  const { run } = recorder();
  const kc = new MacKeychain({ run });
  await expect(kc.set('a" -w "evil', FAKE)).rejects.toThrow("not a valid Keychain account name");
  await expect(kc.get("a\nb")).rejects.toThrow("not a valid Keychain account name");
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
