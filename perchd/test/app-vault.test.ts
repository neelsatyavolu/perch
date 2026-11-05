import { expect, test } from "bun:test";
import { macKeychain, memoryKeychain, type CommandRunner } from "../src/app/keychain";
import { Vault } from "../src/app/vault";

test("a sealed record opens with the same id and key", async () => {
  const vault = await Vault.open(memoryKeychain(), "Default");
  const blob = await vault.sealJson("chat-1", { hello: "world" });
  expect(await vault.openJson("chat-1", blob)).toEqual({ hello: "world" });
});

test("the ciphertext holds no plaintext and differs every time", async () => {
  const vault = await Vault.open(memoryKeychain(), "Default");
  const a = await vault.seal("x", "secret words here");
  const b = await vault.seal("x", "secret words here");
  expect(Buffer.from(a).toString("latin1")).not.toContain("secret words");
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
});

test("a record moved to another id does not open", async () => {
  const vault = await Vault.open(memoryKeychain(), "Default");
  const blob = await vault.seal("chat-1", "data");
  await expect(vault.open("chat-2", blob)).rejects.toThrow(/could not be decrypted/);
});

test("a tampered byte does not open", async () => {
  const vault = await Vault.open(memoryKeychain(), "Default");
  const blob = await vault.seal("chat-1", "data");
  const bad = Uint8Array.from(blob);
  bad[bad.length - 1]! ^= 1;
  await expect(vault.open("chat-1", bad)).rejects.toThrow(/could not be decrypted/);
});

test("the key is created once and read back from the keychain", async () => {
  const keychain = memoryKeychain();
  const first = await Vault.open(keychain, "Default");
  expect(keychain.size()).toBe(1);
  const blob = await first.seal("r", "kept");
  const second = await Vault.open(keychain, "Default");
  expect(keychain.size()).toBe(1);
  expect(new TextDecoder().decode(await second.open("r", blob))).toBe("kept");
});

test("profiles get separate keys", async () => {
  const keychain = memoryKeychain();
  const a = await Vault.open(keychain, "Default");
  const b = await Vault.open(keychain, "Work");
  const blob = await a.seal("r", "x");
  await expect(b.open("r", blob)).rejects.toThrow();
});

test("a broken key in the keychain is reported, not replaced", async () => {
  const keychain = memoryKeychain();
  await keychain.write("Perch Data Key", "Default", "not-a-key");
  await expect(Vault.open(keychain, "Default")).rejects.toThrow(/Keychain item .* is not a Perch key/);
});

test("the macOS adapter passes the secret on stdin, never in the arguments", async () => {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const run: CommandRunner = async (argv, stdin) => {
    calls.push({ argv, stdin });
    return { code: 0, stdout: "" };
  };
  await macKeychain(run).write("Perch Data Key", "Default", "c2VjcmV0LXZhbHVl");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv.join(" ")).not.toContain("c2VjcmV0LXZhbHVl");
  expect(calls[0]!.stdin).toContain("c2VjcmV0LXZhbHVl");
});

test("the macOS adapter reads a secret and treats a missing item as null", async () => {
  const found = macKeychain(async () => ({ code: 0, stdout: "abc\n" }));
  expect(await found.read("s", "a")).toBe("abc");
  const missing = macKeychain(async () => ({ code: 44, stdout: "" }));
  expect(await missing.read("s", "a")).toBeNull();
  const broken = macKeychain(async () => ({ code: 1, stdout: "" }));
  await expect(broken.read("s", "a")).rejects.toThrow(/Keychain/);
});

test("the macOS adapter refuses names and secrets that could break the command", async () => {
  const kc = macKeychain(async () => ({ code: 0, stdout: "" }));
  await expect(kc.write("Perch Data Key", "Default", "a b\nadd-internet-password")).rejects.toThrow();
  await expect(kc.write("Perch\nData", "Default", "abc")).rejects.toThrow();
});
