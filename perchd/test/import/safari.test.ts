import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBookmarksHtml } from "../../src/import/files/bookmarks-html";
import { parseCsv, parsePasswordsCsv } from "../../src/import/files/passwords-csv";
import { parseBplist } from "../../src/import/safari/bplist";
import { readSafariExport } from "../../src/import/safari/export-zip";
import { countSafariHistory, readSafariBookmarks, readSafariHistory } from "../../src/import/safari/safari";
import { toMac } from "../../src/import/time";
import { sqlite, T0, tempHome, write } from "./fixtures";

let env: { home: string; cleanup: () => void };
beforeEach(() => (env = tempHome()));
afterEach(() => {
  chmodSync(env.home, 0o700);
  env.cleanup();
});

const BOOKMARKS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
<key>Children</key><array>
  <dict><key>Title</key><string>History</string><key>WebBookmarkType</key><string>WebBookmarkTypeProxy</string></dict>
  <dict><key>Title</key><string>BookmarksBar</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>
    <dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>https://example.com/</string><key>URIDictionary</key><dict><key>title</key><string>Exämple ✓</string></dict></dict>
    <dict><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Title</key><string>News</string><key>Children</key><array>
      <dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>https://news.example.com/</string><key>URIDictionary</key><dict><key>title</key><string>News site</string></dict></dict>
    </array></dict>
  </array></dict>
  <dict><key>Title</key><string>BookmarksMenu</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>
    <dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>https://menu.example.com/</string><key>URIDictionary</key><dict><key>title</key><string>Menu item</string></dict></dict>
  </array></dict>
  <dict><key>Title</key><string>com.apple.ReadingList</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>
    <dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>https://read.example.com/</string><key>URIDictionary</key><dict><key>title</key><string>Later</string></dict></dict>
  </array></dict>
</array>
<key>Count</key><integer>4294967296</integer><key>Real</key><real>1.5</real><key>Yes</key><true/><key>When</key><date>2026-10-01T12:00:00Z</date><key>Blob</key><data>AQID</data>
</dict></plist>`;

async function binaryPlist(path: string, xml: string): Promise<void> {
  write(path, xml);
  const proc = Bun.spawn(["/usr/bin/plutil", "-convert", "binary1", path]);
  expect(await proc.exited).toBe(0);
}

function safariHistory(dir: string): void {
  const db = sqlite(
    join(dir, "History.db"),
    `CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, domain_expansion TEXT NULL, visit_count INTEGER NOT NULL);
     CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL, visit_time REAL NOT NULL, title TEXT NULL);`,
  );
  db.prepare("INSERT INTO history_items (id, url, visit_count) VALUES (?, ?, ?)").run(1, "https://example.com/", 3);
  db.prepare("INSERT INTO history_items (id, url, visit_count) VALUES (?, ?, ?)").run(2, "file:///etc/hosts", 1);
  const visit = db.prepare("INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)");
  visit.run(1, toMac(T0 - 60_000), "Old title");
  visit.run(1, toMac(T0), "Example");
  visit.run(2, toMac(T0), "hosts");
  db.close();
}

test("binary plists parse every object type Safari uses", async () => {
  const path = join(env.home, "x.plist");
  await binaryPlist(path, BOOKMARKS_XML);
  const plist = parseBplist(Buffer.from(await Bun.file(path).arrayBuffer())) as any;
  expect(plist.Count).toBe(4294967296);
  expect(plist.Real).toBe(1.5);
  expect(plist.Yes).toBe(true);
  expect(plist.When.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  expect([...plist.Blob]).toEqual([1, 2, 3]);
  expect(plist.Children[1].Children[0].URIDictionary.title).toBe("Exämple ✓");
  expect(() => parseBplist(Buffer.from("bplist00 too short"))).toThrow();
});

test("Safari bookmarks: bar, menu and Reading List", async () => {
  const dir = join(env.home, "Library", "Safari");
  await binaryPlist(join(dir, "Bookmarks.plist"), BOOKMARKS_XML);
  const b = readSafariBookmarks(dir);
  expect(b.bar).toEqual([
    { kind: "url", title: "Exämple ✓", url: "https://example.com/" },
    { kind: "folder", title: "News", children: [{ kind: "url", title: "News site", url: "https://news.example.com/" }] },
  ]);
  expect(b.other).toEqual([
    { kind: "url", title: "Menu item", url: "https://menu.example.com/" },
    { kind: "folder", title: "Reading List", children: [{ kind: "url", title: "Later", url: "https://read.example.com/" }] },
  ]);
});

test("Safari history: last visit and its title, web URLs only", async () => {
  const dir = join(env.home, "Library", "Safari");
  safariHistory(dir);
  expect(await readSafariHistory(dir)).toEqual([{ url: "https://example.com/", title: "Example", visitCount: 3, typedCount: 0, lastVisit: T0 }]);
  expect(await countSafariHistory(dir)).toBe(1);
});

test("a blocked Safari folder asks for Full Disk Access", async () => {
  const dir = join(env.home, "Library", "Safari");
  safariHistory(dir);
  await binaryPlist(join(dir, "Bookmarks.plist"), BOOKMARKS_XML);
  chmodSync(join(dir, "History.db"), 0);
  chmodSync(join(dir, "Bookmarks.plist"), 0);
  await expect(readSafariHistory(dir)).rejects.toMatchObject({ reason: "full-disk-access", message: expect.stringContaining("Full Disk Access") });
  expect(() => readSafariBookmarks(dir)).toThrow(/Full Disk Access/);
});

const HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3 ADD_DATE="1790000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1790000000">Tom &amp; Jerry &#8212; &lt;3</A>
    <DT><H3>Nested</H3>
    <DL><p>
      <DT><A HREF="https://nested.example.com/">Nested link</A>
    </DL><p>
  </DL><p>
  <DT><A HREF="javascript:alert(1)">Bad</A>
  <DT><A HREF="https://loose.example.com/">Loose</A>
</DL><p>`;

test("bookmarks HTML: toolbar folder, nesting, entities, unsafe URLs dropped", () => {
  const b = parseBookmarksHtml(HTML);
  expect(b.bar).toEqual([
    { kind: "url", title: "Tom & Jerry — <3", url: "https://example.com/?a=1&b=2", added: 1_790_000_000_000 },
    { kind: "folder", title: "Nested", children: [{ kind: "url", title: "Nested link", url: "https://nested.example.com/" }] },
  ]);
  expect(b.other).toEqual([{ kind: "url", title: "Loose", url: "https://loose.example.com/" }]);
});

test("password CSVs from Safari, Chrome and Firefox", () => {
  expect(parseCsv('a,"b ""q"", c",d\r\n"multi\nline",x,\n')).toEqual([["a", 'b "q", c', "d"], ["multi\nline", "x", ""]]);
  const safari = parsePasswordsCsv("Title,URL,Username,Password,Notes,OTPAuth\nExample,https://example.com/login,ada,pw1,note here,\nNo URL,,bob,pw2,,\n");
  expect(safari).toEqual({ passwords: [{ url: "https://example.com/login", signonRealm: "https://example.com/", username: "ada", password: "pw1", note: "note here" }], skipped: 1 });
  const chrome = parsePasswordsCsv("name,url,username,password,note\nex,https://a.example.com/,u,p,\n");
  expect(chrome.passwords[0]).toMatchObject({ signonRealm: "https://a.example.com/", username: "u", password: "p" });
  const firefox = parsePasswordsCsv('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://f.example.com","fu","fp",,"https://f.example.com","{x}","1","1","1"\n');
  expect(firefox.passwords[0]).toMatchObject({ signonRealm: "https://f.example.com/", username: "fu", password: "fp" });
  expect(() => parsePasswordsCsv("a,b\n1,2\n")).toThrow(/URL and password/);
});

test("Safari's export ZIP: bookmarks, history and passwords without Full Disk Access", async () => {
  const dir = join(env.home, "export");
  write(join(dir, "Bookmarks.html"), HTML);
  write(join(dir, "History.json"), JSON.stringify({ metadata: { browser_name: "Safari", data_type: "history" }, history: [{ url: "https://example.com/", title: "Example", time_usec: T0 * 1000, visit_count: 4 }, { url: "about:blank", time_usec: T0 * 1000 }] }));
  write(join(dir, "Passwords.csv"), "Title,URL,Username,Password,Notes,OTPAuth\nEx,https://example.com/,ada,pw,,\n");
  const zip = join(env.home, "Safari Export.zip");
  const proc = Bun.spawn(["/usr/bin/zip", "-qr", zip, "."], { cwd: dir });
  expect(await proc.exited).toBe(0);
  const data = await readSafariExport(zip);
  expect(data.bookmarks?.bar).toHaveLength(2);
  expect(data.history).toEqual([{ url: "https://example.com/", title: "Example", visitCount: 4, typedCount: 0, lastVisit: T0 }]);
  expect(data.passwords).toHaveLength(1);
  writeFileSync(join(env.home, "not.txt"), "x");
  await expect(readSafariExport(join(env.home, "not.txt"))).rejects.toMatchObject({ reason: "invalid" });
});
