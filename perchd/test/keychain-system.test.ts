import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { systemKeychain } from "../src/config/keychain";

// Touches the login Keychain, so it runs only when asked: PERCH_KEYCHAIN_TEST=1 bun test test/keychain-system.test.ts
// It writes a random throwaway value under its own service name and removes it again.
test.skipIf(process.env.PERCH_KEYCHAIN_TEST !== "1")("the macOS Keychain stores, replaces and removes an item", async () => {
  const kc = systemKeychain("com.perch.perchd.selftest");
  const name = `selftest-${randomUUID().slice(0, 8)}`;
  const value = randomUUID();
  try {
    await kc.set(name, value);
    expect(await kc.get(name)).toBe(value);
    await kc.set(name, `${value}-2`);
    expect(await kc.get(name)).toBe(`${value}-2`);
  } finally {
    expect(await kc.delete(name)).toBe(true);
  }
  expect(await kc.get(name)).toBeNull();
});
