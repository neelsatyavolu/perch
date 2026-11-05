import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { firefoxProfiles } from "../../src/import/detect";
import { countFirefoxCookies, countFirefoxHistory, readFirefoxBookmarks, readFirefoxCookies, readFirefoxHistory, readFirefoxSession } from "../../src/import/firefox/firefox";
import { decodeLz4Block, decodeMozLz4 } from "../../src/import/firefox/mozlz4";
import { firefoxProfile, mozLz4, T0, tempHome } from "./fixtures-firefox";

let env: { home: string; cleanup: () => void };
let profile: string;
beforeEach(() => {
  env = tempHome();
  profile = firefoxProfile(env.home);
});
afterEach(() => env.cleanup());

test("LZ4 blocks with literals and overlapping matches decode", () => {
  // "abcabcabcabcX": literals "abc", then a 9-byte match at offset 3, then literal "X".
  const block = Buffer.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x10, 0x58]);
  expect(decodeLz4Block(block, 13).toString()).toBe("abcabcabcabcX");
  expect(decodeMozLz4(mozLz4(Buffer.from('{"a":1}'))).toString()).toBe('{"a":1}');
  expect(() => decodeLz4Block(Buffer.from([0x0f, 0x05, 0x00]), 4)).toThrow();
  expect(() => decodeMozLz4(Buffer.from("nope"))).toThrow();
});

test("profiles.ini: the install's default profile first", () => {
  const root = join(env.home, "Library", "Application Support", "Firefox");
  expect(firefoxProfiles(root).map((p) => p.name)).toEqual(["default-release", "old"]);
});

test("bookmarks: toolbar, menu and unfiled, tags and separators skipped", async () => {
  const b = await readFirefoxBookmarks(profile);
  expect(b.bar).toEqual([
    { kind: "url", title: "Example", url: "https://example.com/", added: T0 },
    { kind: "folder", title: "Folder", added: T0, children: [{ kind: "url", title: "In folder", url: "https://in.example.com/", added: T0 }] },
  ]);
  expect(b.other.map((n) => n.title)).toEqual(["Menu link", "Unfiled link"]);
});

test("history: visible web pages with typed flag", async () => {
  const h = await readFirefoxHistory(profile);
  expect(h).toEqual([
    { url: "https://example.com/", title: "Example", visitCount: 4, typedCount: 1, lastVisit: T0 },
    { url: "https://in.example.com/", title: "In folder", visitCount: 1, typedCount: 0, lastVisit: T0 - 1000 },
  ]);
  expect(await countFirefoxHistory(profile)).toBe(2);
});

test("cookies: default container only, seconds or milliseconds expiry", async () => {
  expect(await countFirefoxCookies(profile)).toBe(3);
  const cookies = await readFirefoxCookies(profile);
  expect(cookies.map((c) => c.name).sort()).toEqual(["ms", "sid"]);
  expect(cookies.find((c) => c.name === "sid")).toMatchObject({ value: "v1", domain: ".example.com", secure: true, httpOnly: true, sameSite: "Lax" });
});

test("session store: windows, selected tab, pinned, groups, current history entry", () => {
  expect(readFirefoxSession(profile)).toEqual([
    {
      tabs: [
        { url: "https://example.com/2", title: "Second", pinned: true },
        { url: "https://b.example.com/", title: "B", pinned: false, groupId: "g1" },
      ],
      selected: 1,
      groups: [{ id: "g1", title: "Trip", color: "blue", collapsed: false }],
    },
  ]);
});
