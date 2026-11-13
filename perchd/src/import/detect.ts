/**
 * Find the browsers on this Mac and their profiles. Only folder listings and small JSON/INI
 * files are read here; no browser data is opened.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BROWSERS, type BrowserInfo } from "./catalog";

export type Profile = { readonly id: string; readonly name: string; readonly path: string };

export type Source = {
  readonly browser: BrowserInfo;
  readonly profiles: readonly Profile[];
  /** "full-disk-access": the folder exists but macOS blocks reading it until Perch is allowed. */
  readonly access: "ok" | "full-disk-access";
  /** When any of its profiles was last browsed in (Unix ms), from its history file; unset when unknown. */
  readonly lastUsed?: number;
};

export function appSupport(home: string): string {
  return join(home, "Library", "Application Support");
}

export function browserRoot(home: string, browser: BrowserInfo): string {
  if (browser.family === "safari") return join(home, "Library", browser.dir);
  if (browser.family === "aside") return join(home, browser.dir);
  return join(appSupport(home), browser.dir);
}

export function detectSources(home: string, browsers: readonly BrowserInfo[] = BROWSERS): Source[] {
  return browsers.flatMap((browser) => {
    const source = detectOne(home, browser);
    if (!source || (source.profiles.length === 0 && source.access === "ok")) return [];
    const lastUsed = lastUsedOf(source);
    return [lastUsed ? { ...source, lastUsed } : source];
  });
}

function detectOne(home: string, browser: BrowserInfo): Source | undefined {
  const root = browserRoot(home, browser);
  if (!existsSync(root)) return undefined;
  switch (browser.family) {
    case "chromium":
      return { browser, profiles: chromiumProfiles(root, browser), access: "ok" };
    case "firefox":
      return { browser, profiles: firefoxProfiles(root), access: "ok" };
    case "aside":
      return { browser, profiles: asideAccounts(root), access: "ok" };
    case "safari":
      return safariSource(root, browser);
  }
}

/** The file each family writes as you browse; its modification time says when the browser was last used. */
const HISTORY_FILE: Readonly<Record<BrowserInfo["family"], string>> = {
  chromium: "History",
  firefox: "places.sqlite",
  safari: "History.db",
  aside: "",
};

function lastUsedOf(source: Source): number | undefined {
  const file = HISTORY_FILE[source.browser.family];
  if (!file) return undefined;
  // A browser that's open writes to the database's -wal file first.
  const times = source.profiles.flatMap((p) => [mtime(join(p.path, file)), mtime(join(p.path, `${file}-wal`))]).filter((t): t is number => t !== undefined);
  return times.length ? Math.max(...times) : undefined;
}

function mtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function chromiumProfiles(root: string, browser: BrowserInfo): Profile[] {
  if (browser.rootIsProfile) return existsSync(join(root, "Preferences")) ? [{ id: "", name: browser.name, path: root }] : [];
  const cache = readJson(join(root, "Local State"))?.profile?.info_cache;
  const fromLocalState: Profile[] =
    cache && typeof cache === "object"
      ? Object.entries(cache as Record<string, { name?: unknown }>)
          .filter(([id]) => isSafeName(id) && isDir(join(root, id)))
          .map(([id, info]) => ({ id, name: typeof info?.name === "string" && info.name ? info.name : id, path: join(root, id) }))
      : [];
  if (fromLocalState.length > 0) return sortProfiles(fromLocalState);
  // No Local State (or an unreadable one): any folder that looks like a profile.
  const dirs = safeList(root).filter((d) => (d === "Default" || /^Profile \d+$/.test(d)) && existsSync(join(root, d, "Preferences")));
  return sortProfiles(dirs.map((id) => ({ id, name: id === "Default" ? "Default" : id, path: join(root, id) })));
}

function sortProfiles(profiles: Profile[]): Profile[] {
  const rank = (id: string) => (id === "Default" ? -1 : Number(id.replace(/\D/g, "")) || 0);
  return [...profiles].sort((a, b) => rank(a.id) - rank(b.id));
}

function isSafeName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.startsWith(".");
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** profiles.ini: [ProfileN] sections with Path and IsRelative; [Install…] names the default. */
export function firefoxProfiles(root: string): Profile[] {
  let text: string;
  try {
    text = readFileSync(join(root, "profiles.ini"), "utf8");
  } catch {
    return [];
  }
  const sections = parseIni(text);
  const installDefault = Object.entries(sections).find(([name]) => name.startsWith("Install"))?.[1]?.Default;
  const profiles = Object.entries(sections)
    .filter(([name, s]) => name.startsWith("Profile") && s.Path)
    .map(([, s]) => {
      const path = s.IsRelative === "0" ? s.Path! : join(root, s.Path!);
      return { id: s.Path!, name: s.Name || s.Path!, path, isDefault: s.Path === installDefault || (!installDefault && s.Default === "1") };
    })
    .filter((p) => !p.path.split("/").includes("..") && existsSync(join(p.path, "places.sqlite")));
  return [...profiles].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map(({ id, name, path }) => ({ id, name, path }));
}

export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = out[header[1]!] = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function asideAccounts(root: string): Profile[] {
  const info = asideAccountInfo(join(root, ".."));
  return safeList(root)
    .filter((d) => /^\d+$/.test(d) && (isDir(join(root, d, "memory")) || existsSync(join(root, d, "state.db"))))
    .sort((a, b) => Number(a) - Number(b))
    .map((d) => ({ id: d, name: info.names.get(d) ?? `Aside account ${Number(d) + 1}`, path: join(root, d) }));
}

export type AsideAccountInfo = {
  /** Account id ("0", "1", ...) to the name Aside shows for it. */
  readonly names: ReadonlyMap<string, string>;
  /** Aside browser profile folder ("Profile 4") to the agent account it's signed in to. */
  readonly bindings: ReadonlyMap<string, string>;
  readonly current?: string;
};

/**
 * Which Aside agent account each Aside browser profile uses, and the accounts' names, from
 * ~/.aside/accounts.json. That file also holds Aside's session tokens: only `accounts[].id/name`,
 * `currentAccountId` and `profileAccountBindings[].profilePath/accountId` are read, and nothing
 * else in it is kept.
 */
export function asideAccountInfo(asideDir: string): AsideAccountInfo {
  const raw = readJson(join(asideDir, "accounts.json"));
  const names = new Map<string, string>();
  const bindings = new Map<string, string>();
  if (!raw || typeof raw !== "object") return { names, bindings };
  for (const a of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (Number.isInteger(a?.id) && typeof a?.name === "string" && a.name.trim()) names.set(String(a.id), a.name.trim().slice(0, 80));
  }
  const bound = raw.profileAccountBindings && typeof raw.profileAccountBindings === "object" ? Object.values(raw.profileAccountBindings) : [];
  for (const b of bound as { profilePath?: unknown; accountId?: unknown }[]) {
    if (typeof b?.profilePath !== "string" || !Number.isInteger(b?.accountId)) continue;
    const folder = b.profilePath.split("/").filter(Boolean).pop();
    if (folder && isSafeName(folder)) bindings.set(folder, String(b.accountId));
  }
  return { names, bindings, ...(Number.isInteger(raw.currentAccountId) ? { current: String(raw.currentAccountId) } : {}) };
}

function safariSource(root: string, browser: BrowserInfo): Source {
  try {
    readdirSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return { browser, profiles: [{ id: "", name: "Safari", path: root }], access: "full-disk-access" };
    return { browser, profiles: [], access: "ok" };
  }
  return { browser, profiles: [{ id: "", name: "Safari", path: root }], access: "ok" };
}
