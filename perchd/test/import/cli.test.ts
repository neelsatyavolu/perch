import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { main } from "../../src/import/cli";
import { memoryKeychain } from "../../src/import/keychain";
import { chromeProfile, FAKE_SAFE_STORAGE, HISTORY_SCHEMA, sqlite, tempHome } from "./fixtures";

let env: { home: string; cleanup: () => void };
let out: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  env = tempHome();
  out = [];
  spy = spyOn(process.stdout, "write").mockImplementation(((s: string) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write);
});
afterEach(() => {
  spy.mockRestore();
  env.cleanup();
});

test("list, count and import from the terminal print counts and never a secret", async () => {
  chromeProfile(env.home);
  sqlite(join(env.home, "Library", "Application Support", "Perch", "Default", "History"), HISTORY_SCHEMA).close();
  const deps = { home: env.home, keychain: memoryKeychain({ "Chrome Safe Storage": FAKE_SAFE_STORAGE }) };
  expect(await main(["list"], deps)).toBe(0);
  expect(out.join("")).toContain("chrome\tGoogle Chrome\n  Default\tPerson 1");
  out.length = 0;
  expect(await main(["count", "chrome"], deps)).toBe(0);
  expect(out.join("")).toContain("passwords: 1");
  out.length = 0;
  expect(await main(["import", "chrome", "--types", "bookmarks,passwords,cookies"], deps)).toBe(0);
  const text = out.join("");
  expect(text).toBe("bookmarks: 3 added\npasswords: 1 ready, applied when Perch next starts\ncookies: 1 ready, applied when Perch next starts\n");
  expect(text).not.toContain("correct horse");
  expect(await main(["nonsense"], deps)).toBe(64);
});
