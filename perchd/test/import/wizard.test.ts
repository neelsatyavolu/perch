import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BUNDLED_MESSAGE } from "../../src/import/apply";
import { readAsideChats, readAsideMemory, readAsideSkills } from "../../src/import/aside";
import { BUNDLE_SERVICE, discardBundle, openBundle, pendingBundles, sealBundle } from "../../src/import/bundle";
import { readChromeBookmarks } from "../../src/import/chrome/bookmarks";
import { readChromeHistory } from "../../src/import/chrome/history";
import { memoryKeychain } from "../../src/import/keychain";
import { countSource, importFile, importSource, listSources } from "../../src/import/wizard";
import { chromeProfile, FAKE_SAFE_STORAGE, HISTORY_SCHEMA, sqlite, tempHome, write } from "./fixtures";
import { firefoxProfile } from "./fixtures-firefox";

let env: { home: string; cleanup: () => void };
let perch: string;
beforeEach(() => {
  env = tempHome();
  perch = join(env.home, "Library", "Application Support", "Perch");
  sqlite(join(perch, "Default", "History"), HISTORY_SCHEMA).close();
});
afterEach(() => {
  chmodSync(env.home, 0o700);
  env.cleanup();
});

function asideAccount(home: string): string {
  const acct = join(home, ".aside", "u", "0");
  write(join(acct, "memory", "USER.md"), "# User\nLikes tea.\n");
  write(join(acct, "memory", "people", "ada.md"), "Ada");
  write(join(acct, "memory", "memory-index-local.json"), "{}");
  write(join(acct, "credentials.json"), '{"token":"must-never-be-read"}');
  write(join(acct, "skills", "user", "mail", "SKILL.md"), "---\nname: mail\n---\n");
  write(join(acct, "skills", "user", "mail", "run.sh"), "echo hi");
  write(join(acct, "skills", "user", "mail", "logo.png"), "binary");
  write(join(env.home, "secret.md"), "outside");
  symlinkSync(join(env.home, "secret.md"), join(acct, "memory", "link.md"));
  const db = sqlite(
    join(acct, "state.db"),
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Session', incognito INTEGER NOT NULL DEFAULT 0, ephemeral INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, created_at INTEGER NOT NULL);
     CREATE TABLE session_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_message TEXT NOT NULL, final_assistant_message TEXT, started_at INTEGER NOT NULL);
     INSERT INTO sessions (id, title, created_at) VALUES ('s1', 'Flights', 1790000000), ('s2', 'Empty', 1790000000);
     INSERT INTO sessions (id, title, incognito, created_at) VALUES ('s3', 'Private', 1, 1790000000);
     INSERT INTO session_turns (session_id, user_message, final_assistant_message, started_at) VALUES ('s1', 'Find flights', 'Found three.', 1790000001000), ('s3', 'secret', 'x', 1790000001000);`,
  );
  db.close();
  return acct;
}

test("Aside memory, skills and chats; credentials, symlinks and private chats stay behind", async () => {
  const acct = asideAccount(env.home);
  expect(readAsideMemory(acct)).toEqual([
    { path: "USER.md", text: "# User\nLikes tea.\n" },
    { path: "people/ada.md", text: "Ada" },
  ]);
  expect(readAsideSkills(acct).map((f) => f.path)).toEqual(["mail/SKILL.md", "mail/run.sh"]);
  expect(await readAsideChats(acct)).toEqual([{ id: "s1", title: "Flights", created: 1_790_000_000_000, turns: [{ user: "Find flights", assistant: "Found three.", at: 1_790_000_001_000 }] }]);
});

test("bundles are sealed with a Keychain key and fail closed when changed", async () => {
  const keychain = memoryKeychain();
  const { id, path } = await sealBundle(perch, keychain, { browser: "Chrome", profile: "Default" }, { passwords: [{ url: "https://a/", signonRealm: "https://a/", username: "u", password: "fake-test-password" }] });
  expect(readFileSync(path, "utf8")).not.toContain("fake-test-password");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(pendingBundles(perch)).toEqual([id]);
  const bundle = await openBundle(perch, keychain, id);
  expect(bundle.data.passwords?.[0]?.password).toBe("fake-test-password");
  expect(await keychain.find(BUNDLE_SERVICE, id)).toBeTruthy();

  const raw = Buffer.from(readFileSync(path, "utf8"), "base64");
  raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
  write(path, raw.toString("base64"));
  await expect(openBundle(perch, keychain, id)).rejects.toMatchObject({ reason: "unreadable" });
  await discardBundle(perch, keychain, id);
  expect(pendingBundles(perch)).toEqual([]);
  expect(await keychain.find(BUNDLE_SERVICE, id)).toBeNull();
  await expect(openBundle(perch, keychain, "../../etc/passwd")).rejects.toMatchObject({ reason: "invalid" });
});

test("listSources finds each browser and profile and says what needs a prompt", () => {
  chromeProfile(env.home);
  chromeProfile(env.home, "BraveSoftware/Brave-Browser", "Profile 2", "Work");
  firefoxProfile(env.home);
  asideAccount(env.home);
  mkdirSync(join(env.home, "Library", "Safari"), { recursive: true });
  const sources = listSources(env.home, perch);
  expect(sources.map((s) => s.browser)).toEqual(["chrome", "brave", "safari", "firefox", "aside-agent"]);
  const chrome = sources[0]!;
  expect(chrome.profiles).toEqual([{ id: "Default", name: "Person 1" }]);
  expect(chrome.needs.keychain).toEqual(["passwords", "cookies"]);
  expect(chrome.keychainHelp).toBe('macOS will ask whether Perch may use "Chrome Safe Storage". Choose Allow. Perch needs it only during this import, so Always Allow is not needed.');
  expect(sources[2]!.keychainHelp).toBeUndefined();
  expect(sources[1]!.profiles).toEqual([{ id: "Profile 2", name: "Work" }]);
  expect(sources[2]!.needs.fullDiskAccess).toEqual(["bookmarks", "history"]);
  expect(sources[3]!.unsupported.passwords).toMatch(/about:logins/);
});

test("a protected Safari folder is reported as needing Full Disk Access", async () => {
  const safari = join(env.home, "Library", "Safari");
  mkdirSync(safari, { recursive: true });
  chmodSync(safari, 0);
  try {
    expect(listSources(env.home).find((s) => s.browser === "safari")?.access).toBe("full-disk-access");
    await expect(countSource(env.home, { browser: "safari", profile: "" })).rejects.toThrow(/Full Disk Access/);
  } finally {
    chmodSync(safari, 0o700);
  }
});

test("counts never ask the Keychain", async () => {
  chromeProfile(env.home);
  const counts = await countSource(env.home, { browser: "chrome", profile: "Default" });
  expect(counts).toEqual({
    bookmarks: { count: 3 },
    history: { count: 2 },
    tabs: { count: 0 },
    searchEngines: { count: 2 },
    passwords: { count: 1 },
    addresses: { count: 1 },
    cookies: { count: 2 },
    extensions: { count: 1 },
  });
  const firefox = firefoxProfile(env.home);
  expect(firefox).toBeTruthy();
  const ff = await countSource(env.home, { browser: "firefox", profile: "Profiles/abc.default-release" });
  expect(ff.passwords).toEqual({ unavailable: expect.stringMatching(/Export Logins/) });
});

test("importing from Chrome: bookmarks and history written, the rest sealed in one bundle, one Keychain prompt", async () => {
  chromeProfile(env.home);
  const keychain = memoryKeychain({ "Chrome Safe Storage": FAKE_SAFE_STORAGE });
  const progress: string[] = [];
  const report = await importSource({
    home: env.home,
    source: { browser: "chrome", profile: "Default" },
    types: ["bookmarks", "history", "passwords", "cookies", "searchEngines", "addresses", "extensions", "tabs"],
    target: { userDataDir: perch },
    keychain,
    onProgress: (p) => progress.push(`${p.type}:${p.state}`),
  });
  expect(report.results).toEqual([
    { type: "bookmarks", status: "written", count: 3 },
    { type: "history", status: "written", count: 2 },
    { type: "tabs", status: "empty", count: 0 },
    { type: "searchEngines", status: "bundled", count: 2, message: BUNDLED_MESSAGE },
    { type: "passwords", status: "bundled", count: 1, message: BUNDLED_MESSAGE },
    { type: "addresses", status: "bundled", count: 1, message: BUNDLED_MESSAGE },
    { type: "cookies", status: "bundled", count: 1, skipped: 1, message: BUNDLED_MESSAGE },
    { type: "extensions", status: "bundled", count: 1, message: BUNDLED_MESSAGE },
  ]);
  expect(keychain.asked).toEqual(["Chrome Safe Storage"]);
  expect(progress).toContain("passwords:reading");
  expect(readChromeBookmarks(join(perch, "Default", "Bookmarks")).bar.map((b) => b.title)).toEqual(["Example", "Work"]);
  expect((await readChromeHistory(join(perch, "Default", "History"))).map((h) => h.url)).toEqual(["https://example.com/", "https://news.example.com/a"]);
  const bundle = await openBundle(perch, keychain, report.bundle!.id);
  expect(bundle.source).toEqual({ browser: "Google Chrome", profile: "Person 1" });
  expect(bundle.data.passwords?.[0]?.username).toBe("ada@example.com");
  expect(bundle.data.bookmarks).toBeUndefined();
  expect(listSources(env.home, perch)[0]!.profiles[0]!.lastImported).toBeGreaterThan(0);

  const again = await importSource({ home: env.home, source: { browser: "chrome", profile: "Default" }, types: ["bookmarks", "history"], target: { userDataDir: perch }, keychain });
  expect(again.results).toEqual([
    { type: "bookmarks", status: "written", count: 0, skipped: 3 },
    { type: "history", status: "written", count: 0, skipped: 2 },
  ]);
});

test("a denied Keychain prompt fails passwords only, and Perch being open sends everything to the bundle", async () => {
  chromeProfile(env.home);
  symlinkSync(`${hostname()}-${process.pid}`, join(perch, "SingletonLock"));
  const report = await importSource({
    home: env.home,
    source: { browser: "chrome", profile: "Default" },
    types: ["bookmarks", "passwords"],
    target: { userDataDir: perch },
    keychain: memoryKeychain({}, ["Chrome Safe Storage"]),
  });
  expect(report.results).toEqual([
    { type: "bookmarks", status: "bundled", count: 3, message: BUNDLED_MESSAGE },
    { type: "passwords", status: "failed", count: 0, message: expect.stringMatching(/did not allow/) },
  ]);
});

test("bad input is refused with a plain message", async () => {
  const base = { home: env.home, target: { userDataDir: perch }, keychain: memoryKeychain() };
  await expect(importSource({ ...base, source: { browser: "netscape", profile: "x" }, types: ["bookmarks"] })).rejects.toThrow(/does not import from/);
  chromeProfile(env.home);
  await expect(importSource({ ...base, source: { browser: "chrome", profile: "Default" }, types: [] })).rejects.toThrow(/at least one/);
  await expect(importSource({ ...base, source: { browser: "chrome", profile: "Default" }, types: ["bookmarks", "everything"] })).rejects.toThrow(/Unknown data type: everything/);
  await expect(importSource({ ...base, source: { browser: "chrome", profile: "Nope" }, types: ["bookmarks"] })).rejects.toMatchObject({ reason: "not-found" });
  const firefox = await importSource({ ...base, source: { browser: "chrome", profile: "Default" }, types: ["memory"] });
  expect(firefox.results[0]).toMatchObject({ status: "unavailable" });
});

test("files: a password CSV goes to the bundle, a bookmarks HTML file is written", async () => {
  const keychain = memoryKeychain();
  const csv = join(env.home, "Passwords.csv");
  write(csv, "url,username,password\nhttps://a.example.com,u,p\n,x,y\n");
  const r = await importFile({ path: csv, target: { userDataDir: perch }, keychain });
  expect(r.results).toEqual([{ type: "passwords", status: "bundled", count: 1, skipped: 1, message: BUNDLED_MESSAGE }]);
  const html = join(env.home, "bookmarks.html");
  write(html, '<DL><p><DT><A HREF="https://x.example.com/">X</A></DL>');
  const b = await importFile({ path: html, target: { userDataDir: perch }, keychain });
  expect(b.results).toEqual([{ type: "bookmarks", status: "written", count: 1 }]);
  expect(readChromeBookmarks(join(perch, "Default", "Bookmarks")).other).toEqual([
    { kind: "folder", title: "Imported from bookmarks.html", added: expect.any(Number), children: [{ kind: "url", title: "X", url: "https://x.example.com/", added: expect.any(Number) }] },
  ]);
  await expect(importFile({ path: join(env.home, "x.exe"), target: { userDataDir: perch }, keychain })).rejects.toMatchObject({ reason: "invalid" });
});
