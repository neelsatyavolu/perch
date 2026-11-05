/** A generated Firefox profile (places, cookies, session store) for import tests. */

import { join } from "node:path";
import { sqlite, T0, write } from "./fixtures";

export { T0, tempHome } from "./fixtures";

/** A valid LZ4 block made only of literals (one final sequence). */
export function lz4Literals(data: Buffer): Buffer {
  const n = data.length;
  if (n < 15) return Buffer.concat([Buffer.from([n << 4]), data]);
  const extra: number[] = [];
  let rest = n - 15;
  while (rest >= 255) {
    extra.push(255);
    rest -= 255;
  }
  extra.push(rest);
  return Buffer.concat([Buffer.from([0xf0, ...extra]), data]);
}

export function mozLz4(data: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write("mozLz40\0", 0, "latin1");
  head.writeUInt32LE(data.length, 8);
  return Buffer.concat([head, lz4Literals(data)]);
}

export function firefoxProfile(home: string): string {
  const root = join(home, "Library", "Application Support", "Firefox");
  write(
    join(root, "profiles.ini"),
    "[Profile1]\nName=old\nIsRelative=1\nPath=Profiles/old.default\nDefault=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n\n[Install4F96D1932A9F858E]\nDefault=Profiles/abc.default-release\nLocked=1\n\n[General]\nStartWithLastProfile=1\nVersion=2\n",
  );
  const us = T0 * 1000;
  sqlite(join(root, "Profiles", "old.default", "places.sqlite"), "CREATE TABLE moz_places (id INTEGER PRIMARY KEY)").close();
  const profile = join(root, "Profiles", "abc.default-release");
  const places = sqlite(
    join(profile, "places.sqlite"),
    `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER, guid TEXT);
     CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER, position INTEGER, title LONGVARCHAR, keyword_id INTEGER, folder_type TEXT, dateAdded INTEGER, lastModified INTEGER, guid TEXT);`,
  );
  const place = places.prepare("INSERT INTO moz_places (id, url, title, visit_count, hidden, typed, last_visit_date) VALUES (?, ?, ?, ?, ?, ?, ?)");
  place.run(1, "https://example.com/", "Example", 4, 0, 1, us);
  place.run(2, "https://in.example.com/", "In folder", 1, 0, 0, us - 1_000_000);
  place.run(3, "https://menu.example.com/", "Menu link", 0, 0, 0, null);
  place.run(4, "https://unfiled.example.com/", "Unfiled link", 0, 0, 0, null);
  place.run(5, "place:tag=x", "query", 1, 0, 0, us);
  place.run(6, "https://hidden.example.com/", "Hidden", 1, 1, 0, us);
  const bm = places.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  bm.run(1, 2, null, 0, 0, "", us, "root________");
  bm.run(2, 2, null, 1, 0, "menu", us, "menu________");
  bm.run(3, 2, null, 1, 1, "toolbar", us, "toolbar_____");
  bm.run(4, 2, null, 1, 2, "tags", us, "tags________");
  bm.run(5, 2, null, 1, 3, "unfiled", us, "unfiled_____");
  bm.run(6, 2, null, 1, 4, "mobile", us, "mobile______");
  bm.run(10, 1, 1, 3, 0, "Example", us, "b10");
  bm.run(11, 3, null, 3, 1, null, us, "b11");
  bm.run(12, 2, null, 3, 2, "Folder", us, "b12");
  bm.run(13, 1, 2, 12, 0, "In folder", us, "b13");
  bm.run(14, 1, 3, 2, 0, "Menu link", null, "b14");
  bm.run(15, 1, 4, 5, 0, "Unfiled link", null, "b15");
  bm.run(16, 2, null, 4, 0, "a-tag", us, "b16");
  bm.run(17, 1, 1, 16, 0, null, us, "b17");
  places.close();

  const cookies = sqlite(
    join(profile, "cookies.sqlite"),
    "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0, isPartitionedAttributeSet INTEGER DEFAULT 0)",
  );
  const cookie = cookies.prepare("INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const future = Math.floor(Date.now() / 1000) + 86_400;
  cookie.run("", "sid", "v1", ".example.com", "/", future, 1, 1, 1);
  cookie.run("", "ms", "v2", "ms.example.com", "/", future * 1000, 0, 0, 0);
  cookie.run("", "old", "v3", "old.example.com", "/", 1000, 0, 0, 0);
  cookie.run("^userContextId=1", "work", "v4", "work.example.com", "/", future, 0, 0, 0);
  cookies.close();

  const session = {
    windows: [
      {
        selected: 3,
        groups: [{ id: "g1", name: "Trip", color: "blue", collapsed: false }, { id: "unused", name: "Empty", color: "red" }],
        tabs: [
          { entries: [{ url: "https://example.com/1", title: "First" }, { url: "https://example.com/2", title: "Second" }], index: 2, pinned: true },
          { entries: [{ url: "about:newtab", title: "New Tab" }], index: 1 },
          { entries: [{ url: "https://b.example.com/", title: "B" }], index: 1, groupId: "g1" },
        ],
      },
      { tabs: [{ entries: [{ url: "about:blank" }], index: 1 }] },
    ],
  };
  write(join(profile, "sessionstore-backups", "recovery.jsonlz4"), mozLz4(Buffer.from(JSON.stringify(session))));
  return profile;
}
