/**
 * One interface over every source: count what a profile holds (cheaply, with no Keychain
 * prompt), and read one data type. Each family says which types need the Keychain or Full Disk
 * Access, so the wizard can explain that before asking.
 */

import { join } from "node:path";
import { countAsideChats, readAsideChats, readAsideMemory, readAsideSkills } from "./aside";
import type { BrowserInfo } from "./catalog";
import { readChromeBookmarks } from "./chrome/bookmarks";
import { countChromeCookies, readChromeCookies } from "./chrome/cookies";
import { safeStorageKey, type SafeStorageKey } from "./chrome/crypto";
import { readChromeExtensions } from "./chrome/extensions";
import { countChromeHistory, readChromeHistory } from "./chrome/history";
import { countChromeLogins, readChromeLogins } from "./chrome/logins";
import { readChromeSession } from "./chrome/snss";
import { readChromeWebData } from "./chrome/web-data";
import type { Profile } from "./detect";
import { countFirefoxCookies, countFirefoxHistory, readFirefoxBookmarks, readFirefoxCookies, readFirefoxHistory, readFirefoxSession } from "./firefox/firefox";
import type { Keychain } from "./keychain";
import { countSafariCookies, readSafariCookies } from "./safari/binarycookies";
import { countSafariHistory, readSafariBookmarks, readSafariHistory } from "./safari/safari";
import { countBookmarks, ImportError, type Bookmarks, type Counts, type DataType, type ImportData, type SessionWindow } from "./types";

export type ReadResult = { readonly data: ImportData; readonly skipped?: number };

export type SourceReader = {
  readonly types: readonly DataType[];
  readonly needsKeychain: readonly DataType[];
  readonly needsFullDiskAccess: readonly DataType[];
  /** Types this source cannot provide, with what the user can do instead. */
  readonly unsupported: Partial<Record<DataType, string>>;
  count(type: DataType): Promise<number>;
  read(type: DataType, keychain: Keychain): Promise<ReadResult>;
};

const bookmarkCount = (b: Bookmarks) => countBookmarks(b.bar) + countBookmarks(b.other) + countBookmarks(b.mobile);
const tabCount = (w: readonly SessionWindow[]) => w.reduce((n, x) => n + x.tabs.length, 0);

function chromiumReader(browser: BrowserInfo, profile: Profile): SourceReader {
  const p = profile.path;
  let key: Promise<SafeStorageKey> | undefined;
  // One Keychain prompt per import, shared by passwords and cookies.
  const getKey = (keychain: Keychain) => (key ??= safeStorageKey(keychain, browser.safeStorage ?? [], browser.name));
  return {
    types: ["bookmarks", "history", "tabs", "searchEngines", "passwords", "addresses", "cookies", "extensions"],
    needsKeychain: ["passwords", "cookies"],
    needsFullDiskAccess: [],
    unsupported: {},
    async count(type) {
      switch (type) {
        case "bookmarks":
          return bookmarkCount(readChromeBookmarks(join(p, "Bookmarks")));
        case "history":
          return countChromeHistory(join(p, "History"));
        case "tabs":
          return tabCount(readChromeSession(p));
        case "searchEngines":
          return (await readChromeWebData(p)).searchEngines.length;
        case "addresses":
          return (await readChromeWebData(p)).addresses.length;
        case "passwords":
          return countChromeLogins(p);
        case "cookies":
          return countChromeCookies(p);
        case "extensions":
          return readChromeExtensions(p).length;
        default:
          return 0;
      }
    },
    async read(type, keychain) {
      switch (type) {
        case "bookmarks":
          return { data: { bookmarks: readChromeBookmarks(join(p, "Bookmarks")) } };
        case "history":
          return { data: { history: await readChromeHistory(join(p, "History")) } };
        case "tabs":
          return { data: { tabs: readChromeSession(p) } };
        case "searchEngines":
          return { data: { searchEngines: (await readChromeWebData(p)).searchEngines } };
        case "addresses":
          return { data: { addresses: (await readChromeWebData(p)).addresses } };
        case "passwords": {
          const r = await readChromeLogins(p, await getKey(keychain));
          return { data: { passwords: r.passwords }, skipped: r.undecryptable };
        }
        case "cookies": {
          const r = await readChromeCookies(p, await getKey(keychain));
          return { data: { cookies: r.cookies }, skipped: r.undecryptable + r.partitioned };
        }
        case "extensions":
          return { data: { extensions: readChromeExtensions(p) } };
        default:
          return { data: {} };
      }
    },
  };
}

function safariReader(profile: Profile): SourceReader {
  const p = profile.path;
  return {
    types: ["bookmarks", "history", "cookies"],
    needsKeychain: [],
    needsFullDiskAccess: ["bookmarks", "history", "cookies"],
    unsupported: {
      passwords: "In Safari, choose File > Export Browsing Data to File, include passwords, then import that ZIP file.",
      tabs: "Safari's open tabs are not imported yet.",
    },
    async count(type) {
      if (type === "bookmarks") return bookmarkCount(readSafariBookmarks(p));
      if (type === "history") return countSafariHistory(p);
      if (type === "cookies") return countSafariCookies(p);
      return 0;
    },
    async read(type) {
      if (type === "bookmarks") return { data: { bookmarks: readSafariBookmarks(p) } };
      if (type === "history") return { data: { history: await readSafariHistory(p) } };
      if (type === "cookies") return { data: { cookies: await readSafariCookies(p) } };
      return { data: {} };
    },
  };
}

function firefoxReader(profile: Profile): SourceReader {
  const p = profile.path;
  return {
    types: ["bookmarks", "history", "tabs", "cookies"],
    needsKeychain: [],
    needsFullDiskAccess: [],
    unsupported: { passwords: "Firefox keeps passwords encrypted with its own key. In Firefox, open about:logins, choose Export Logins, then import that CSV file." },
    async count(type) {
      if (type === "bookmarks") return bookmarkCount(await readFirefoxBookmarks(p));
      if (type === "history") return countFirefoxHistory(p);
      if (type === "tabs") return tabCount(readFirefoxSession(p));
      if (type === "cookies") return countFirefoxCookies(p);
      return 0;
    },
    async read(type) {
      if (type === "bookmarks") return { data: { bookmarks: await readFirefoxBookmarks(p) } };
      if (type === "history") return { data: { history: await readFirefoxHistory(p) } };
      if (type === "tabs") return { data: { tabs: readFirefoxSession(p) } };
      if (type === "cookies") return { data: { cookies: await readFirefoxCookies(p) } };
      return { data: {} };
    },
  };
}

function asideReader(profile: Profile): SourceReader {
  const p = profile.path;
  return {
    types: ["memory", "skills", "chats"],
    needsKeychain: [],
    needsFullDiskAccess: [],
    unsupported: {},
    async count(type) {
      if (type === "memory") return readAsideMemory(p).length;
      if (type === "skills") return new Set(readAsideSkills(p).map((f) => f.path.split("/")[0])).size;
      if (type === "chats") return countAsideChats(p);
      return 0;
    },
    async read(type) {
      if (type === "memory") return { data: { memory: readAsideMemory(p) } };
      if (type === "skills") return { data: { skills: readAsideSkills(p) } };
      if (type === "chats") return { data: { chats: await readAsideChats(p) } };
      return { data: {} };
    },
  };
}

export function readerFor(browser: BrowserInfo, profile: Profile): SourceReader {
  switch (browser.family) {
    case "chromium":
      return chromiumReader(browser, profile);
    case "safari":
      return safariReader(profile);
    case "firefox":
      return firefoxReader(profile);
    case "aside":
      return asideReader(profile);
  }
}

/** Counts for every type: a number, or why it is unavailable. Never prompts. */
export async function countAll(reader: SourceReader): Promise<Counts> {
  const entries = await Promise.all(
    [...reader.types.map(async (type) => {
      try {
        return [type, { count: await reader.count(type) }] as const;
      } catch (error) {
        return [type, { unavailable: error instanceof ImportError ? error.message : "This data could not be read." }] as const;
      }
    }), ...Object.entries(reader.unsupported).map(async ([type, why]) => [type, { unavailable: why! }] as const)],
  );
  return Object.fromEntries(entries) as Counts;
}
