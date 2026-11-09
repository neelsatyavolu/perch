import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { BUNDLED_MESSAGE } from "../../src/import/apply";
import { memoryKeychain } from "../../src/import/keychain";
import { importSource } from "../../src/import/wizard";
import { Browser } from "../../src/browser/browser";
import { chromeProfile, FAKE_SAFE_STORAGE, HISTORY_SCHEMA, sqlite, tempHome } from "./fixtures";

// Perch running: a headless browser holds the target user data dir, as Perch does while perchd runs.
let env: { home: string; cleanup: () => void };
let perch: string;
let browser: Browser;
beforeEach(async () => {
  env = tempHome();
  perch = join(env.home, "Library", "Application Support", "Perch");
  sqlite(join(perch, "Default", "History"), HISTORY_SCHEMA).close();
  browser = await Browser.launch({ userDataDir: perch, args: ["--use-mock-keychain", "--password-store=basic"] });
});
afterEach(async () => {
  await browser.close();
  env.cleanup();
});

test("with Perch running, cookies go straight in over the DevTools pipe; the rest waits in the bundle", async () => {
  chromeProfile(env.home);
  const report = await importSource({
    home: env.home,
    source: { browser: "chrome", profile: "Default" },
    types: ["bookmarks", "cookies"],
    target: { userDataDir: perch },
    keychain: memoryKeychain({ "Chrome Safe Storage": FAKE_SAFE_STORAGE }),
    running: browser.conn,
  });
  expect(report.results).toEqual([
    { type: "bookmarks", status: "bundled", count: 3, message: BUNDLED_MESSAGE },
    { type: "cookies", status: "written", count: 2 },
  ]);
  const { cookies } = await browser.conn.send<{ cookies: { name: string; value: string; domain: string }[] }>("Storage.getCookies", {});
  expect(cookies.find((c) => c.name === "sid")).toMatchObject({ value: "test-session-value", domain: ".example.com" });
  // The partitioned cookie arrives still tied to its top-level site.
  expect(cookies.find((c) => c.name === "pid")).toMatchObject({ value: "partitioned", partitionKey: { topLevelSite: "https://embedder.test" } });
}, 60_000);
