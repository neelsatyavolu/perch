import { expect, test } from "bun:test";
import { decrypt, encrypt, KEY_BYTES, loadDataKey } from "../src/memory/crypto";
import { macKeychain, mockKeychain, type SecurityRunner } from "../src/memory/keychain";

const key = () => crypto.getRandomValues(new Uint8Array(KEY_BYTES));

test("a record round-trips and the ciphertext does not contain the plaintext", () => {
  const k = key();
  const blob = encrypt(k, "Maya Chen is my sister", "pages/abc");
  expect(Buffer.from(blob).includes(Buffer.from("Maya"))).toBe(false);
  expect(decrypt(k, blob, "pages/abc").toString("utf8")).toBe("Maya Chen is my sister");
});

test("two encryptions of the same text differ (fresh IV each time)", () => {
  const k = key();
  expect(Buffer.from(encrypt(k, "same", "a")).equals(Buffer.from(encrypt(k, "same", "a")))).toBe(false);
});

test("the wrong key, a changed byte, or another record's id fails to decrypt", () => {
  const k = key();
  const blob = encrypt(k, "secret fact", "pages/one");
  expect(() => decrypt(key(), blob, "pages/one")).toThrow("could not be decrypted");
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1]! ^= 1;
  expect(() => decrypt(k, tampered, "pages/one")).toThrow("could not be decrypted");
  expect(() => decrypt(k, blob, "pages/two")).toThrow("could not be decrypted");
  expect(() => decrypt(k, Buffer.from("not a record"), "pages/one")).toThrow("not a Perch record");
});

test("a key of the wrong size is refused", () => {
  expect(() => encrypt(new Uint8Array(16), "x", "a")).toThrow("32 bytes");
});

test("loadDataKey creates a key once and reads the same key back", async () => {
  const store = mockKeychain();
  const first = await loadDataKey(store, "default", { create: true });
  const second = await loadDataKey(store, "default", { create: true });
  expect(first.length).toBe(KEY_BYTES);
  expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  expect([...store.accounts()]).toEqual(["data-key:default"]);
});

test("loadDataKey refuses to make a new key when data already exists", async () => {
  await expect(loadDataKey(mockKeychain(), "default", { create: false })).rejects.toThrow("Perch's data key is missing from the Keychain");
});

test("loadDataKey rejects a damaged key in the Keychain", async () => {
  const store = mockKeychain();
  await store.set("data-key:default", "c2hvcnQ=");
  await expect(loadDataKey(store, "default", { create: true })).rejects.toThrow("damaged");
});

test("the macOS Keychain store passes secrets on stdin, never in arguments", async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  const run: SecurityRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "find-generic-password") return { code: 0, stdout: "c2VjcmV0\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const kc = macKeychain({ run });
  await kc.set("data-key:default", "c2VjcmV0");
  expect(calls[0]!.args).toEqual(["-i"]);
  expect(calls[0]!.stdin).toBe("add-generic-password -U -s Perch -a data-key:default -w c2VjcmV0\n");
  expect(await kc.get("data-key:default")).toBe("c2VjcmV0");
  expect(calls[1]!.args).toEqual(["find-generic-password", "-s", "Perch", "-a", "data-key:default", "-w"]);
  for (const c of calls) expect(c.args.join(" ")).not.toContain("c2VjcmV0");
});

test("the macOS Keychain store maps not-found to null and reports other failures without the secret", async () => {
  const kc = macKeychain({ run: async () => ({ code: 44, stdout: "", stderr: "could not be found" }) });
  expect(await kc.get("data-key:default")).toBeNull();
  await kc.delete("data-key:default");
  const broken = macKeychain({ run: async () => ({ code: 51, stdout: "", stderr: "user interaction is not allowed" }) });
  await expect(broken.set("data-key:default", "c2VjcmV0")).rejects.toThrow("Keychain");
  await expect(broken.set("data-key:default", "c2VjcmV0")).rejects.not.toThrow("c2VjcmV0");
});

test("account names and secrets with spaces or quotes are refused", async () => {
  const kc = macKeychain({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  await expect(kc.set("bad account", "x")).rejects.toThrow("account");
  await expect(kc.set("data-key:x", "a b")).rejects.toThrow("secret");
});
