/**
 * The readers and writers against a profile made by a real (headless) Chrome for Testing:
 * Chrome writes history, a cookie and a session; the readers must read them. Then bookmarks and
 * history are written into the closed profile and Chrome must show them after a restart.
 * `--use-mock-keychain` makes Chrome use the test password "mock_password" instead of the Keychain.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../src/browser/browser";
import { readChromeCookies } from "../../src/import/chrome/cookies";
import { deriveKey } from "../../src/import/chrome/crypto";
import { readChromeHistory } from "../../src/import/chrome/history";
import { readChromeSession } from "../../src/import/chrome/snss";
import { readChromeBookmarks } from "../../src/import/chrome/bookmarks";
import { mergeBookmarksFile } from "../../src/import/write/bookmarks-file";
import { addHistory } from "../../src/import/write/history-db";
import { profileInUse } from "../../src/import/write/profile-lock";
import { snapshot } from "../../src/page/snapshot";

const ARGS = ["--use-mock-keychain", "--password-store=basic"];
let dir: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-import-real-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("<title>Fixture page</title><p>hello</p>", { headers: { "content-type": "text/html", "set-cookie": "fixture=cookie-value-1; Max-Age=86400; Path=/; SameSite=Lax" } }),
  });
  const browser = await Browser.launch({ userDataDir: dir, args: ARGS });
  const tab = await browser.newTab(`http://127.0.0.1:${server.port}/visited`);
  await tab.settle();
  await Bun.sleep(1200); // history and cookies are written on a short timer
  await browser.close();
}, 60_000);

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("Chrome's own history, cookie and session files read back", async () => {
  const profile = join(dir, "Default");
  const url = `http://127.0.0.1:${server.port}/visited`;
  const history = await readChromeHistory(join(profile, "History"));
  expect(history.find((h) => h.url === url)).toMatchObject({ title: "Fixture page", visitCount: 1 });
  const { cookies, undecryptable } = await readChromeCookies(profile, deriveKey("mock_password"));
  expect(undecryptable).toBe(0);
  expect(cookies.find((c) => c.name === "fixture")).toMatchObject({ value: "cookie-value-1", domain: "127.0.0.1", sameSite: "Lax" });
  const urls = readChromeSession(profile).flatMap((w) => w.tabs.map((t) => t.url));
  expect(urls).toContain(url);
});

test("bookmarks and history written while closed show up in Chrome", async () => {
  expect(profileInUse(dir)).toBe(false);
  const profile = join(dir, "Default");
  const added = mergeBookmarksFile(join(profile, "Bookmarks"), { bar: [{ kind: "url", title: "Imported bookmark", url: "https://imported.example.com/" }], other: [], mobile: [] }, "Imported from Test");
  expect(added.added).toBe(1);
  expect(addHistory(join(profile, "History"), [{ url: "https://history.example.com/page", title: "Imported history page", visitCount: 3, typedCount: 0, lastVisit: Date.now() - 3_600_000 }])).toBe(1);

  const browser = await Browser.launch({ userDataDir: dir, args: ARGS });
  try {
    expect(profileInUse(dir)).toBe(true);
    const tab = await browser.newTab("chrome://history/");
    await Bun.sleep(800);
    expect((await snapshot(tab, { full: true })).text).toContain("Imported history page");
    await tab.navigate("chrome://bookmarks/");
    await Bun.sleep(800);
    expect((await snapshot(tab, { full: true })).text).toContain("Imported bookmark");
  } finally {
    await browser.close();
  }
  // Chrome kept the file (a bad checksum or format would make it rewrite or drop the node).
  expect(readChromeBookmarks(join(profile, "Bookmarks")).bar.map((b) => b.title)).toContain("Imported bookmark");
}, 60_000);
