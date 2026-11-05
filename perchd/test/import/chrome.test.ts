import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readChromeBookmarks } from "../../src/import/chrome/bookmarks";
import { readChromeCookies, countChromeCookies } from "../../src/import/chrome/cookies";
import { decrypt, deriveKey, encrypt, safeStorageKey } from "../../src/import/chrome/crypto";
import { readChromeExtensions } from "../../src/import/chrome/extensions";
import { countChromeHistory, readChromeHistory } from "../../src/import/chrome/history";
import { countChromeLogins, readChromeLogins } from "../../src/import/chrome/logins";
import { CMD, parseSnss, readChromeSession } from "../../src/import/chrome/snss";
import { readChromeWebData } from "../../src/import/chrome/web-data";
import { memoryKeychain } from "../../src/import/keychain";
import { chromeProfile, FAKE_KEY, FAKE_SAFE_STORAGE, ints, pickle, snss, T0, tempHome, write, type ChromeFixture } from "./fixtures";

let env: { home: string; cleanup: () => void };
let fx: ChromeFixture;
beforeEach(() => {
  env = tempHome();
  fx = chromeProfile(env.home);
});
afterEach(() => env.cleanup());

test("v10 values round-trip and a wrong key or foreign prefix reads as undefined", () => {
  const sealed = encrypt(FAKE_KEY, Buffer.from("secret"));
  expect(sealed.subarray(0, 3).toString()).toBe("v10");
  expect(decrypt(FAKE_KEY, sealed)?.toString()).toBe("secret");
  expect(decrypt(deriveKey("wrong"), sealed)).toBeUndefined();
  expect(decrypt(FAKE_KEY, Buffer.from("v20abc"))).toBeUndefined();
});

test("the Safe Storage key comes from the first Keychain label that exists", async () => {
  const keychain = memoryKeychain({ "Chrome Safe Storage/Chrome": FAKE_SAFE_STORAGE });
  const key = await safeStorageKey(keychain, [{ service: "Nope Safe Storage", account: "Nope" }, { service: "Chrome Safe Storage", account: "Chrome" }], "Chrome");
  expect(key.bytes.equals(FAKE_KEY.bytes)).toBe(true);
  expect(keychain.asked).toEqual(["Nope Safe Storage", "Chrome Safe Storage"]);
  await expect(safeStorageKey(memoryKeychain({}, ["X Safe Storage"]), [{ service: "X Safe Storage", account: "X" }], "X")).rejects.toMatchObject({ reason: "keychain-denied" });
  await expect(safeStorageKey(memoryKeychain(), [{ service: "X Safe Storage", account: "X" }], "X")).rejects.toMatchObject({ reason: "not-found" });
});

test("bookmarks keep folders, titles and add dates", () => {
  const b = readChromeBookmarks(join(fx.profile, "Bookmarks"));
  expect(b.bar).toEqual([
    { kind: "url", title: "Example", url: "https://example.com/", added: T0 },
    { kind: "folder", title: "Work", added: undefined, children: [{ kind: "url", title: "Docs", url: "https://docs.example.com/", added: undefined }] },
  ]);
  expect(b.other).toHaveLength(1);
  expect(readChromeBookmarks(join(fx.profile, "missing"))).toEqual({ bar: [], other: [], mobile: [] });
});

test("history skips hidden and non-web URLs", async () => {
  const h = await readChromeHistory(join(fx.profile, "History"));
  expect(h.map((e) => e.url)).toEqual(["https://example.com/", "https://news.example.com/a"]);
  expect(h[0]).toEqual({ url: "https://example.com/", title: "Example", visitCount: 5, typedCount: 2, lastVisit: T0 });
  expect(await countChromeHistory(join(fx.profile, "History"))).toBe(2);
});

test("passwords are counted without the key and decrypted with it; never-save entries are skipped", async () => {
  expect(await countChromeLogins(fx.profile)).toBe(1);
  const { passwords, undecryptable } = await readChromeLogins(fx.profile, FAKE_KEY);
  expect(undecryptable).toBe(0);
  expect(passwords).toEqual([{ url: "https://login.example.com/signin", signonRealm: "https://login.example.com/", username: "ada@example.com", password: "correct horse battery", created: T0 }]);
  const wrong = await readChromeLogins(fx.profile, deriveKey("wrong"));
  expect(wrong).toEqual({ passwords: [], undecryptable: 1 });
});

test("search engines: user-added ones and the default; addresses from the token tables", async () => {
  const { searchEngines, addresses } = await readChromeWebData(fx.profile);
  expect(searchEngines).toEqual([
    { name: "DuckDuckGo", keyword: "duckduckgo.com", url: "https://duckduckgo.com/?q={searchTerms}", suggestUrl: "https://duckduckgo.com/ac/?q={searchTerms}", isDefault: true },
    { name: "Wiki", keyword: "w", url: "https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}", isDefault: false },
  ]);
  expect(addresses).toEqual([
    { name: "Ada Lovelace", organization: "Example Co", street: "1 Test Street", city: "Testville", state: "CA", zip: "94000", country: "US", phone: "+15550100", email: "ada@example.com" },
  ]);
});

test("cookies: v24 hash prefix removed, expired ones dropped, partitioned ones left out", async () => {
  expect(await countChromeCookies(fx.profile)).toBe(2);
  const { cookies, undecryptable, partitioned } = await readChromeCookies(fx.profile, FAKE_KEY);
  expect(undecryptable).toBe(0);
  expect(partitioned).toBe(1);
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({ name: "sid", value: "test-session-value", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  expect(cookies[0]!.expires).toBeGreaterThan(Date.now() / 1000);
});

test("extensions are listed with localized names and store links", () => {
  expect(readChromeExtensions(fx.profile)).toEqual([
    { id: "aaaabbbbccccddddeeeeffffgggghhhh", name: "Test Blocker", version: "1.2.0", storeUrl: "https://chromewebstore.google.com/detail/aaaabbbbccccddddeeeeffffgggghhhh" },
  ]);
});

const nav = (tab: number, index: number, url: string, title: string) => [CMD.updateTabNavigation, pickle().int(tab).int(index).string(url).string16(title).string("state").int(0).done()] as [number, Buffer];

test("session file: windows, tab order, selected tab, pinned, groups, closed tabs", () => {
  const groupPayload = Buffer.alloc(32);
  groupPayload.writeInt32LE(11, 0);
  groupPayload.writeBigUInt64LE(1n, 8);
  groupPayload.writeBigUInt64LE(2n, 16);
  groupPayload[24] = 1;
  const file = snss([
    [CMD.setWindowType, ints(1, 0)],
    [CMD.setTabWindow, ints(1, 10)],
    [CMD.setTabWindow, ints(1, 11)],
    [CMD.setTabWindow, ints(1, 12)],
    [CMD.setTabIndexInWindow, ints(10, 1)],
    [CMD.setTabIndexInWindow, ints(11, 0)],
    [CMD.setTabIndexInWindow, ints(12, 2)],
    nav(10, 0, "https://a.example.com/", "A old"),
    nav(10, 1, "https://a.example.com/2", "A new"),
    [CMD.setSelectedNavigationIndex, ints(10, 1)],
    nav(11, 0, "https://b.example.com/", "B ü"),
    [CMD.setSelectedNavigationIndex, ints(11, 0)],
    nav(12, 0, "https://closed.example.com/", "Closed"),
    [CMD.tabClosed, Buffer.concat([ints(12, 0), Buffer.alloc(8)])],
    [CMD.setPinnedState, Buffer.from([11, 0, 0, 0, 1, 0, 0, 0])],
    [CMD.setTabGroup, groupPayload],
    [CMD.setTabGroupMetadata2, pickle().uint64(1n).uint64(2n).string16("Trip").int(1).int(1).done()],
    [CMD.setSelectedTabInIndex, ints(1, 1)],
    [CMD.setWindowType, ints(2, 1)],
    [CMD.setTabWindow, ints(2, 20)],
    nav(20, 0, "https://popup.example.com/", "Popup"),
  ]);
  const windows = parseSnss(file)!;
  expect(windows).toHaveLength(1);
  const gid = "00000000000000010000000000000002";
  expect(windows[0]).toEqual({
    tabs: [
      { url: "https://b.example.com/", title: "B ü", pinned: true, groupId: gid },
      { url: "https://a.example.com/2", title: "A new", pinned: false },
    ],
    selected: 1,
    groups: [{ id: gid, title: "Trip", color: "blue", collapsed: true }],
  });
  expect(parseSnss(Buffer.from("nope"))).toBeUndefined();
  expect(parseSnss(snss([], 2))).toBeUndefined();
});

test("the newest Sessions/Session_ file is read", () => {
  write(join(fx.profile, "Sessions", "Session_13300000000000000"), snss([[CMD.setTabWindow, ints(1, 1)], nav(1, 0, "https://old.example.com/", "Old")]));
  write(join(fx.profile, "Sessions", "Session_13400000000000000"), snss([[CMD.setTabWindow, ints(1, 1)], nav(1, 0, "https://new.example.com/", "New")]));
  expect(readChromeSession(fx.profile)[0]!.tabs[0]!.url).toBe("https://new.example.com/");
  expect(readChromeSession(join(env.home, "none"))).toEqual([]);
});
