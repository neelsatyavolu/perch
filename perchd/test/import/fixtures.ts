/**
 * Generated browser profiles for import tests. Everything here is made up: fake Keychain
 * passwords, example.com sites, test-only values. Nothing is read from the real Mac.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { deriveKey, encrypt } from "../../src/import/chrome/crypto";
import { toChromium } from "../../src/import/time";

export const FAKE_SAFE_STORAGE = "test-only-safe-storage-password";
export const FAKE_KEY = deriveKey(FAKE_SAFE_STORAGE);
export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "perch-import-home-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function write(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export function sqlite(path: string, sql: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(sql);
  return db;
}

export const HISTORY_SCHEMA = `
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER DEFAULT 0 NOT NULL,typed_count INTEGER DEFAULT 0 NOT NULL,last_visit_time INTEGER NOT NULL,hidden INTEGER DEFAULT 0 NOT NULL);
CREATE INDEX urls_url_index ON urls (url);
CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT,url INTEGER NOT NULL,visit_time INTEGER NOT NULL,from_visit INTEGER,external_referrer_url TEXT,transition INTEGER DEFAULT 0 NOT NULL,segment_id INTEGER,visit_duration INTEGER DEFAULT 0 NOT NULL,incremented_omnibox_typed_score BOOLEAN DEFAULT FALSE NOT NULL,opener_visit INTEGER,originator_cache_guid TEXT,originator_visit_id INTEGER,originator_from_visit INTEGER,originator_opener_visit INTEGER,is_known_to_sync BOOLEAN DEFAULT FALSE NOT NULL,consider_for_ntp_most_visited BOOLEAN DEFAULT FALSE NOT NULL,visited_link_id INTEGER DEFAULT 0 NOT NULL,app_id TEXT);
CREATE INDEX visits_url_index ON visits (url);
CREATE INDEX visits_time_index ON visits (visit_time);
INSERT INTO meta VALUES ('version', '70');
`;

export const LOGINS_SCHEMA = `
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE logins (origin_url VARCHAR NOT NULL, action_url VARCHAR, username_element VARCHAR, username_value VARCHAR, password_element VARCHAR, password_value BLOB, submit_element VARCHAR, signon_realm VARCHAR NOT NULL, date_created INTEGER NOT NULL, blacklisted_by_user INTEGER NOT NULL, scheme INTEGER NOT NULL, password_type INTEGER, times_used INTEGER, form_data BLOB, display_name VARCHAR, icon_url VARCHAR, federation_url VARCHAR, skip_zero_click INTEGER, generation_upload_status INTEGER, possible_username_pairs BLOB, id INTEGER PRIMARY KEY AUTOINCREMENT, date_last_used INTEGER NOT NULL DEFAULT 0, moving_blocked_for BLOB, date_password_modified INTEGER NOT NULL DEFAULT 0, UNIQUE (origin_url, username_element, username_value, password_element, signon_realm));
INSERT INTO meta VALUES ('version', '43');
`;

export const COOKIES_SCHEMA = `
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
INSERT INTO meta VALUES ('version', '24');
`;

const chromeUs = (ms: number) => toChromium(ms).toString();

export type ChromeFixture = { root: string; profile: string };

/** A full Chromium-family profile with one or two of every data type. */
export function chromeProfile(home: string, dir = "Google/Chrome", profileDir = "Default", profileName = "Person 1"): ChromeFixture {
  const root = join(home, "Library", "Application Support", dir);
  const profile = join(root, profileDir);
  write(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { [profileDir]: { name: profileName } } } }));
  write(join(profile, "Preferences"), JSON.stringify({ default_search_provider: { guid: "guid-ddg" } }));
  write(
    join(profile, "Bookmarks"),
    JSON.stringify({
      checksum: "ignored",
      version: 1,
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "Bookmarks bar",
          children: [
            { type: "url", name: "Example", url: "https://example.com/", date_added: chromeUs(T0) },
            { type: "folder", name: "Work", children: [{ type: "url", name: "Docs", url: "https://docs.example.com/" }] },
          ],
        },
        other: { type: "folder", name: "Other bookmarks", children: [{ type: "url", name: "Other", url: "https://other.example.com/" }] },
        synced: { type: "folder", name: "Mobile bookmarks", children: [] },
      },
    }),
  );
  const history = sqlite(join(profile, "History"), HISTORY_SCHEMA);
  const addUrl = history.prepare("INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?)");
  addUrl.run("https://example.com/", "Example", 5, 2, chromeUs(T0), 0);
  addUrl.run("https://news.example.com/a", "News A", 1, 0, chromeUs(T0 - 60_000), 0);
  addUrl.run("chrome://settings/", "Settings", 1, 0, chromeUs(T0), 0);
  addUrl.run("https://hidden.example.com/", "Hidden", 1, 0, chromeUs(T0), 1);
  history.close();

  const logins = sqlite(join(profile, "Login Data"), LOGINS_SCHEMA);
  const addLogin = logins.prepare(
    "INSERT INTO logins (origin_url, action_url, username_element, username_value, password_element, password_value, submit_element, signon_realm, date_created, blacklisted_by_user, scheme) VALUES (?, '', '', ?, '', ?, '', ?, ?, ?, 0)",
  );
  addLogin.run("https://login.example.com/signin", "ada@example.com", encrypt(FAKE_KEY, Buffer.from("correct horse battery")), "https://login.example.com/", chromeUs(T0), 0);
  addLogin.run("https://never.example.com/", "", Buffer.alloc(0), "https://never.example.com/", chromeUs(T0), 1);
  logins.close();

  const web = sqlite(
    join(profile, "Web Data"),
    `CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
     CREATE TABLE keywords (id INTEGER PRIMARY KEY,short_name VARCHAR NOT NULL,keyword VARCHAR NOT NULL,favicon_url VARCHAR NOT NULL,url VARCHAR NOT NULL,safe_for_autoreplace INTEGER,originating_url VARCHAR,date_created INTEGER DEFAULT 0,usage_count INTEGER DEFAULT 0,input_encodings VARCHAR,suggest_url VARCHAR,prepopulate_id INTEGER DEFAULT 0,created_by_policy INTEGER DEFAULT 0,last_modified INTEGER DEFAULT 0,sync_guid VARCHAR,alternate_urls VARCHAR,image_url VARCHAR,search_url_post_params VARCHAR,suggest_url_post_params VARCHAR,image_url_post_params VARCHAR,new_tab_url VARCHAR,last_visited INTEGER DEFAULT 0, created_from_play_api INTEGER DEFAULT 0, is_active INTEGER DEFAULT 0, starter_pack_id INTEGER DEFAULT 0, enforced_by_policy INTEGER DEFAULT 0, featured_by_policy INTEGER DEFAULT 0, url_hash BLOB);
     INSERT INTO keywords (id, short_name, keyword, favicon_url, url, suggest_url, prepopulate_id, sync_guid) VALUES
       (1, 'Google', 'google.com', '', '{google:baseURL}search?q={searchTerms}', '', 1, 'guid-google'),
       (2, 'DuckDuckGo', 'duckduckgo.com', '', 'https://duckduckgo.com/?q={searchTerms}', 'https://duckduckgo.com/ac/?q={searchTerms}', 92, 'guid-ddg'),
       (3, 'Wiki', 'w', '', 'https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}', NULL, 0, 'guid-wiki');
     INSERT INTO keywords (id, short_name, keyword, favicon_url, url, prepopulate_id, starter_pack_id, sync_guid) VALUES (4, 'Bookmarks', '@bookmarks', '', 'chrome://bookmarks/?q={searchTerms}', 0, 1, 'guid-sp');
     CREATE TABLE addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR, label VARCHAR, initial_creator_id INTEGER DEFAULT 0, last_modifier_id INTEGER DEFAULT 0, record_type INTEGER);
     CREATE TABLE address_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0, observations BLOB, PRIMARY KEY (guid, type));
     INSERT INTO addresses (guid) VALUES ('a1');
     INSERT INTO address_type_tokens (guid, type, value) VALUES ('a1', 7, 'Ada Lovelace'), ('a1', 77, '1 Test Street'), ('a1', 33, 'Testville'), ('a1', 34, 'CA'), ('a1', 35, '94000'), ('a1', 36, 'US'), ('a1', 14, '+15550100'), ('a1', 9, 'ada@example.com'), ('a1', 60, 'Example Co');`,
  );
  web.close();

  const cookies = sqlite(join(profile, "Network", "Cookies"), COOKIES_SCHEMA);
  const addCookie = cookies.prepare(
    "INSERT INTO cookies VALUES (?, ?, '', ?, '', ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, 2, 443, ?, 0, 0)",
  );
  const sealed = (host: string, value: string) => encrypt(FAKE_KEY, Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]));
  const future = chromeUs(Date.now() + 86_400_000);
  addCookie.run(chromeUs(T0), ".example.com", "sid", sealed(".example.com", "test-session-value"), "/", future, 1, 1, chromeUs(T0), 1, chromeUs(T0));
  addCookie.run(chromeUs(T0), "old.example.com", "gone", sealed("old.example.com", "x"), "/", chromeUs(T0 - 86_400_000), 0, 0, chromeUs(T0), 1, chromeUs(T0));
  // A partitioned (CHIPS) cookie: only readable under its top-level site, and imported with that partition.
  cookies
    .prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, '', ?, ?, ?, 1, 0, ?, 1, 1, 1, 0, 2, 443, ?, 0, 1)")
    .run(chromeUs(T0), ".tracker.test", "https://embedder.test", "pid", sealed(".tracker.test", "partitioned"), "/", future, chromeUs(T0), chromeUs(T0));
  cookies.close();

  const ext = join(profile, "Extensions", "aaaabbbbccccddddeeeeffffgggghhhh", "1.2.0_0");
  write(join(ext, "manifest.json"), JSON.stringify({ name: "__MSG_name__", version: "1.2.0", default_locale: "en", update_url: "https://clients2.google.com/service/update2/crx" }));
  write(join(ext, "_locales", "en", "messages.json"), JSON.stringify({ name: { message: "Test Blocker" } }));
  write(join(profile, "Extensions", "Temp", "x"), "not an extension");
  return { root, profile };
}

// ---- SNSS (Chromium session file) encoder, mirroring the reader ----

class PickleWriter {
  private parts: Buffer[] = [];
  private pad(b: Buffer): Buffer {
    const rem = b.length % 4;
    return rem ? Buffer.concat([b, Buffer.alloc(4 - rem)]) : b;
  }
  int(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.parts.push(b);
    return this;
  }
  uint64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    this.parts.push(b);
    return this;
  }
  string(s: string): this {
    const b = Buffer.from(s, "utf8");
    this.int(b.length);
    this.parts.push(this.pad(b));
    return this;
  }
  string16(s: string): this {
    const b = Buffer.from(s, "utf16le");
    this.int(s.length);
    this.parts.push(this.pad(b));
    return this;
  }
  done(): Buffer {
    const body = Buffer.concat(this.parts);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
  }
}

export const pickle = () => new PickleWriter();

export function ints(...values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeInt32LE(v, i * 4));
  return b;
}

export function snss(commands: [number, Buffer][], version = 3): Buffer {
  const head = Buffer.alloc(8);
  head.write("SNSS", 0, "latin1");
  head.writeInt32LE(version, 4);
  return Buffer.concat([
    head,
    ...commands.map(([id, payload]) => {
      const h = Buffer.alloc(3);
      h.writeUInt16LE(payload.length + 1, 0);
      h[2] = id;
      return Buffer.concat([h, payload]);
    }),
  ]);
}

export type AsideFixture = {
  readonly memory?: Readonly<Record<string, string>>;
  /** Skill files by path under skills/user, like "mail/SKILL.md". */
  readonly skills?: Readonly<Record<string, string>>;
  readonly chats?: readonly { readonly id: string; readonly title: string; readonly created: number; readonly turns: readonly (readonly [user: string, assistant: string | null])[] }[];
};

/** Aside's agent folder (~/.aside/u/0) with made-up memory, skills and chats. Returns the account folder. */
export function asideAgent(home: string, data: AsideFixture, id = 0): string {
  const account = join(home, ".aside", "u", String(id));
  for (const [path, text] of Object.entries(data.memory ?? {})) write(join(account, "memory", path), text);
  for (const [path, text] of Object.entries(data.skills ?? {})) write(join(account, "skills", "user", path), text);
  const db = sqlite(
    join(account, "state.db"),
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Session', incognito INTEGER NOT NULL DEFAULT 0, ephemeral INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, created_at INTEGER NOT NULL);
     CREATE TABLE session_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_message TEXT NOT NULL, final_assistant_message TEXT, started_at INTEGER NOT NULL);`,
  );
  const session = db.prepare("INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)");
  const turn = db.prepare("INSERT INTO session_turns (session_id, user_message, final_assistant_message, started_at) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const chat of data.chats ?? []) {
      session.run(chat.id, chat.title, chat.created);
      chat.turns.forEach(([user, assistant], i) => turn.run(chat.id, user, assistant, chat.created + (i + 1) * 1000));
    }
  })();
  db.close();
  return account;
}
