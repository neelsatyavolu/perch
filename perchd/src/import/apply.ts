/**
 * Put read data into Perch. Bookmarks and history go straight into the profile's Chromium files
 * when Perch is closed (and History already exists). Cookies go straight into a running Perch
 * over the DevTools pipe perchd holds. Everything else, and those types when they cannot be
 * written now, goes into one sealed bundle. The browser does not apply bundles yet (plan 2/3b),
 * so results say the data is saved for a later version, not that it is in Perch.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CdpConnection } from "../cdp/connection";
import { sealBundle } from "./bundle";
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
};

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
    const bundle = await sealBundle(input.target.userDataDir, input.keychain, input.source, data, input.now);
    const bundled = toBundle.map((p): TypeResult => ({ type: p.type, status: "bundled", count: itemCount(p.type, p.data), ...(p.skipped ? { skipped: p.skipped } : {}), message: BUNDLED_MESSAGE }));
    return { results: sorted([...results, ...bundled]), bundle };
  } catch (error) {
    return { results: sorted([...results, ...toBundle.map((p) => failure(p.type, error))]) };
  }
}
