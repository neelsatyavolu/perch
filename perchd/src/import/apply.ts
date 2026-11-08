/**
 * Put read data into Perch. Bookmarks and history go straight into the profile's Chromium files
 * when Perch is closed (and History already exists). Cookies go straight into a running Perch
 * over the DevTools pipe perchd holds. Everything else, and those types when they cannot be
 * written now, goes into one sealed bundle. Inside Perch the browser applies that bundle at once
 * (`Perch.applyImportBundle`, plan 3b task 14): perchd unseals it into a 0600 temp file the browser
 * reads, and deletes the file after the call. What the browser does not apply stays sealed, and
 * results say it is saved for a later version, not that it is in Perch.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportApplied, PerchDomainApi } from "../browser/perch-domain";
import type { CdpConnection } from "../cdp/connection";
import { bundleDir, discardBundle, openBundle, sealBundle, sealReplacingBundle } from "./bundle";
import { applyCookies } from "./cookies-cdp";
import type { Keychain } from "./keychain";
import { countBookmarks, ImportError, type DataType, type ImportData } from "./types";
import { mergeBookmarksFile } from "./write/bookmarks-file";
import { addHistory } from "./write/history-db";
import { profileInUse } from "./write/profile-lock";

export type Target = { readonly userDataDir: string; readonly profileDir?: string };

export type TypeResult = {
  readonly type: DataType;
  /** written: in Perch now. bundled: saved, sealed, for a later version of Perch to add. empty: nothing to import. */
  readonly status: "written" | "bundled" | "empty" | "failed" | "unavailable";
  readonly count: number;
  /** Items left out (could not be decrypted, no URL, duplicates of what Perch has). */
  readonly skipped?: number;
  readonly message?: string;
};

export const BUNDLED_MESSAGE = "Saved in an encrypted import file. This version of Perch cannot add this data yet; a later version will add it.";

export type Progress = { readonly type: DataType; readonly state: "reading" | "writing" | "done" | "failed"; readonly index: number; readonly total: number };

export function itemCount(type: DataType, data: ImportData): number {
  switch (type) {
    case "bookmarks":
      return data.bookmarks ? countBookmarks(data.bookmarks.bar) + countBookmarks(data.bookmarks.other) + countBookmarks(data.bookmarks.mobile) : 0;
    case "tabs":
      return (data.tabs ?? []).reduce((n, w) => n + w.tabs.length, 0);
    default:
      return (data[type] as readonly unknown[] | undefined)?.length ?? 0;
  }
}

export function failure(type: DataType, error: unknown): TypeResult {
  const message = error instanceof ImportError ? error.message : "This data could not be read.";
  return { type, status: "failed", count: 0, message };
}

/** Write what can be written now; return the results and the data left for the bundle. */
function writeDirect(type: DataType, data: ImportData, target: Target, label: string, closed: boolean): TypeResult | undefined {
  if (!closed) return undefined;
  const profile = join(target.userDataDir, target.profileDir ?? "Default");
  if (type === "bookmarks" && data.bookmarks) {
    const total = itemCount("bookmarks", data);
    const { added } = mergeBookmarksFile(join(profile, "Bookmarks"), data.bookmarks, label);
    return { type, status: "written", count: added, ...(total > added ? { skipped: total - added } : {}) };
  }
  if (type === "history" && data.history && existsSync(join(profile, "History"))) {
    const added = addHistory(join(profile, "History"), data.history);
    return { type, status: "written", count: added, ...(data.history.length > added ? { skipped: data.history.length - added } : {}) };
  }
  return undefined;
}

export type ApplyInput = {
  readonly target: Target;
  readonly keychain: Keychain;
  readonly source: { readonly browser: string; readonly profile: string };
  /** Per type: the data read, and how many items the reader had to leave out. */
  readonly parts: readonly { readonly type: DataType; readonly data: ImportData; readonly skipped?: number }[];
  readonly onProgress?: (p: Progress) => void;
  readonly now?: number;
  /** The DevTools pipe to the running Perch, when perchd holds one; cookies are applied through it. */
  readonly running?: CdpConnection;
  /** Perch's browser, which applies the sealed bundle itself when it has `Perch.applyImportBundle`. */
  readonly browser?: Pick<PerchDomainApi, "applyImportBundle">;
};

/** The types the browser writes from a bundle; the rest wait in it. */
const BROWSER_TYPES = ["bookmarks", "history", "passwords", "cookies", "tabs", "searchEngines"] as const satisfies readonly (keyof ImportApplied & DataType)[];

type BrowserOutcome = { applied: ImportApplied; skipped: readonly string[] };

/**
 * Hands one sealed bundle to the browser: its plain JSON goes into a fresh 0600 file in a 0700
 * folder beside the bundles, and that file is deleted when the call ends, however it ends.
 * Null when the browser lacks the method or the call failed; the bundle then stays as it is.
 */
async function applyInBrowser(userDataDir: string, keychain: Keychain, id: string, browser: NonNullable<ApplyInput["browser"]>): Promise<BrowserOutcome | null> {
  const bundle = await openBundle(userDataDir, keychain, id);
  const dir = join(bundleDir(userDataDir), "applying");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${randomUUID()}.json`);
  try {
    writeFileSync(path, JSON.stringify(bundle), { mode: 0o600, flag: "wx" });
    return await browser.applyImportBundle({ path });
  } catch {
    return null;
  } finally {
    rmSync(path, { force: true });
  }
}

/** Reseals what the browser left (or discards the bundle when nothing is left). */
async function keepUnapplied(userDataDir: string, keychain: Keychain, id: string, done: ReadonlySet<DataType>, now?: number): Promise<{ id: string; path: string } | undefined> {
  const bundle = await openBundle(userDataDir, keychain, id);
  const left = Object.fromEntries(Object.entries(bundle.data).filter(([type]) => !done.has(type as DataType))) as ImportData;
  const kept = Object.keys(left).length ? await sealBundle(userDataDir, keychain, bundle.source, left, now) : undefined;
  await discardBundle(userDataDir, keychain, id);
  return kept;
}

async function writeLive(type: DataType, data: ImportData, running: CdpConnection | undefined, closed: boolean): Promise<TypeResult | undefined> {
  if (closed || !running || type !== "cookies" || !data.cookies) return undefined;
  const { applied, failed } = await applyCookies(running, data.cookies);
  return { type, status: "written", count: applied, ...(failed ? { skipped: failed } : {}) };
}

export async function applyImport(input: ApplyInput): Promise<{ results: TypeResult[]; bundle?: { id: string; path: string } }> {
  const closed = !profileInUse(input.target.userDataDir);
  const label = `Imported from ${input.source.browser}`;
  const results: TypeResult[] = [];
  const toBundle: { type: DataType; data: ImportData; skipped?: number }[] = [];
  for (const [index, part] of input.parts.entries()) {
    const count = itemCount(part.type, part.data);
    if (count === 0) {
      results.push({ type: part.type, status: "empty", count: 0, ...(part.skipped ? { skipped: part.skipped } : {}) });
      continue;
    }
    input.onProgress?.({ type: part.type, state: "writing", index, total: input.parts.length });
    try {
      const direct = writeDirect(part.type, part.data, input.target, label, closed) ?? (await writeLive(part.type, part.data, input.running, closed));
      if (direct) results.push(part.skipped ? { ...direct, skipped: (direct.skipped ?? 0) + part.skipped } : direct);
      else toBundle.push(part);
    } catch (error) {
      results.push(failure(part.type, error));
    }
  }
  const order = (r: TypeResult) => input.parts.findIndex((p) => p.type === r.type);
  const sorted = (list: TypeResult[]) => [...list].sort((a, b) => order(a) - order(b));
  if (toBundle.length === 0) return { results: sorted(results) };
  try {
    const data = Object.assign({}, ...toBundle.map((p) => p.data)) as ImportData;
    const bundle = await sealReplacingBundle(input.target.userDataDir, input.keychain, input.source, data, input.now);
    const bundled = toBundle.map((p): TypeResult => ({ type: p.type, status: "bundled", count: itemCount(p.type, p.data), ...(p.skipped ? { skipped: p.skipped } : {}), message: BUNDLED_MESSAGE }));
    const outcome = input.browser ? await applyInBrowser(input.target.userDataDir, input.keychain, bundle.id, input.browser) : null;
    if (!outcome) return { results: sorted([...results, ...bundled]), bundle };
    const done = new Set<DataType>(BROWSER_TYPES.filter((t) => typeof outcome.applied[t] === "number" && !outcome.skipped.includes(t)));
    const written = bundled.map((r): TypeResult => {
      if (!done.has(r.type)) return r;
      const count = outcome.applied[r.type as (typeof BROWSER_TYPES)[number]];
      const left = r.count - count + (r.skipped ?? 0);
      return { type: r.type, status: "written", count, ...(left > 0 ? { skipped: left } : {}) };
    });
    const kept = await keepUnapplied(input.target.userDataDir, input.keychain, bundle.id, done, input.now);
    return { results: sorted([...results, ...written]), ...(kept ? { bundle: kept } : {}) };
  } catch (error) {
    return { results: sorted([...results, ...toBundle.map((p) => failure(p.type, error))]) };
  }
}
