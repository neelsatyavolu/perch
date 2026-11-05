import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readChromeBookmarks } from "../../src/import/chrome/bookmarks";
import { readChromeHistory } from "../../src/import/chrome/history";
import { toChromium } from "../../src/import/time";
import type { Bookmarks } from "../../src/import/types";
import { bookmarkChecksum, mergeBookmarksFile } from "../../src/import/write/bookmarks-file";
import { addHistory } from "../../src/import/write/history-db";
import { profileInUse } from "../../src/import/write/profile-lock";
import { HISTORY_SCHEMA, sqlite, T0, tempHome, write } from "./fixtures";

let env: { home: string; cleanup: () => void };
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const imported: Bookmarks = {
  bar: [
    { kind: "url", title: "Example", url: "https://example.com/", added: T0 },
    { kind: "folder", title: "Work", children: [{ kind: "url", title: "Docs", url: "https://docs.example.com/" }] },
  ],
  other: [{ kind: "url", title: "Other", url: "https://other.example.com/" }],
  mobile: [],
};

test("checksum matches Chromium's algorithm (MD5 of id, UTF-16 title, type, url)", () => {
  // Computed independently: md5("1" + utf16le("Bookmarks bar") + "folder" + "4" + utf16le("é") + "url" + "https://e.com/" + "2" + utf16le("Other bookmarks") + "folder" + "3" + utf16le("Mobile bookmarks") + "folder")
  const parts = [Buffer.from("1"), Buffer.from("Bookmarks bar", "utf16le"), Buffer.from("folder"), Buffer.from("4"), Buffer.from("é", "utf16le"), Buffer.from("url"), Buffer.from("https://e.com/"), Buffer.from("2"), Buffer.from("Other bookmarks", "utf16le"), Buffer.from("folder"), Buffer.from("3"), Buffer.from("Mobile bookmarks", "utf16le"), Buffer.from("folder")];
  const expected = new Bun.CryptoHasher("md5").update(Buffer.concat(parts)).digest("hex");
  const roots = {
    bookmark_bar: { id: "1", name: "Bookmarks bar", type: "folder", children: [{ id: "4", name: "é", type: "url", url: "https://e.com/" }] },
    other: { id: "2", name: "Other bookmarks", type: "folder", children: [] },
    synced: { id: "3", name: "Mobile bookmarks", type: "folder", children: [] },
  };
  expect(bookmarkChecksum(roots)).toBe(expected);
});

test("a new Bookmarks file puts the bar on the bar and the rest in an import folder", () => {
  const path = join(env.home, "Default", "Bookmarks");
  const result = mergeBookmarksFile(path, imported, "Imported from Chrome");
  expect(result.added).toBe(3);
  const json = JSON.parse(readFileSync(path, "utf8"));
  expect(json.checksum).toBe(bookmarkChecksum(json.roots));
  expect(json.version).toBe(1);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const back = readChromeBookmarks(path);
  expect(back.bar.map((n) => n.title)).toEqual(["Example", "Work"]);
  expect(back.other).toEqual([{ kind: "folder", title: "Imported from Chrome", added: expect.any(Number), children: [{ kind: "url", title: "Other", url: "https://other.example.com/", added: expect.any(Number) }] }]);
  const ids = JSON.stringify(json).match(/"id":"(\d+)"/g)!;
  expect(new Set(ids).size).toBe(ids.length);
});

test("into an existing bar, imports go in a folder; a second import adds nothing", () => {
  const path = join(env.home, "Default", "Bookmarks");
  mergeBookmarksFile(path, { bar: [{ kind: "url", title: "Mine", url: "https://mine.example.com/" }], other: [], mobile: [] }, "Imported from Safari");
  const first = mergeBookmarksFile(path, imported, "Imported from Chrome");
  expect(first.added).toBe(3);
  const bar = readChromeBookmarks(path).bar;
  expect(bar.map((n) => n.title)).toEqual(["Mine", "Imported from Chrome"]);
  const again = mergeBookmarksFile(path, imported, "Imported from Chrome");
  expect(again.added).toBe(0);
  expect(readChromeBookmarks(path).bar).toHaveLength(2);
});

test("history rows are added once, merged with what the profile already has", async () => {
  const path = join(env.home, "History");
  const db = sqlite(path, HISTORY_SCHEMA);
  db.prepare("INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, ?, ?, ?)").run("https://example.com/", "", 1, 0, toChromium(T0 - 1000).toString());
  db.close();
  const entries = [
    { url: "https://example.com/", title: "Example", visitCount: 5, typedCount: 2, lastVisit: T0 },
    { url: "https://new.example.com/", title: "New", visitCount: 1, typedCount: 0, lastVisit: T0 - 5000 },
    { url: "javascript:alert(1)", title: "x", visitCount: 1, typedCount: 0, lastVisit: T0 },
  ];
  expect(addHistory(path, entries)).toBe(2);
  expect(addHistory(path, entries)).toBe(0);
  const back = await readChromeHistory(path);
  expect(back).toEqual([
    { url: "https://example.com/", title: "Example", visitCount: 5, typedCount: 2, lastVisit: T0 },
    { url: "https://new.example.com/", title: "New", visitCount: 1, typedCount: 0, lastVisit: T0 - 5000 },
  ]);
  const check = new Database(path);
  expect((check.query("SELECT COUNT(*) AS n FROM visits").get() as { n: number }).n).toBe(2);
  check.close();
});

test("history needs the database Perch created", () => {
  expect(() => addHistory(join(env.home, "none"), [])).toThrow(/History/);
});

test("a profile is in use while SingletonLock points at a live process on this Mac", () => {
  const dir = join(env.home, "Perch");
  write(join(dir, "Local State"), "{}");
  expect(profileInUse(dir)).toBe(false);
  symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
  expect(profileInUse(dir)).toBe(true);
});

test("a stale SingletonLock (dead process) does not block", () => {
  const dir = join(env.home, "Perch");
  write(join(dir, "Local State"), "{}");
  symlinkSync(`${hostname()}-999999`, join(dir, "SingletonLock"));
  expect(profileInUse(dir)).toBe(false);
});
