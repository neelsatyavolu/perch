import { afterEach, beforeEach, expect, test } from "bun:test";
import { macKeychain } from "../../src/import/keychain";
import { tempKeychain } from "./temp-keychain";

// A throwaway keychain file with fake values; the user's own keychains are never touched.
let kc: { path: string; cleanup: () => void };
beforeEach(() => (kc = tempKeychain()));
afterEach(() => kc.cleanup());

const TRUSTED_APP = "/System/Applications/Calculator.app";

function accessList(path: string): string {
  // -a prints access lists only; secrets are never decrypted (no -d).
  return Bun.spawnSync(["/usr/bin/security", "dump-keychain", "-a", path]).stdout.toString();
}

test("items round-trip through Security.framework, and set replaces an existing item", async () => {
  const keychain = macKeychain({ keychainPath: kc.path });
  expect(await keychain.find("Perch Import", "missing")).toBeNull();
  await keychain.set("Perch Import", "id-1", "fake-key-1");
  expect(await keychain.find("Perch Import", "id-1")).toBe("fake-key-1");
  await keychain.set("Perch Import", "id-1", "fake-key-2");
  expect(await keychain.find("Perch Import", "id-1")).toBe("fake-key-2");
  await keychain.remove("Perch Import", "id-1");
  expect(await keychain.find("Perch Import", "id-1")).toBeNull();
  await keychain.remove("Perch Import", "id-1");
});

test("a new item's access list trusts perchd and Perch.app, never /usr/bin/security", async () => {
  await macKeychain({ keychainPath: kc.path, trustedApps: [TRUSTED_APP] }).set("Perch Import", "id-2", "fake-key");
  const dump = accessList(kc.path);
  const decrypt = dump.split("entry ").find((e) => e.includes("decrypt")) ?? "";
  expect(decrypt).toContain(process.execPath);
  expect(decrypt).toContain(TRUSTED_APP);
  expect(dump).not.toContain("/usr/bin/security");
  expect(dump).not.toContain("fake-key");
});
