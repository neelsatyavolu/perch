/**
 * The import wizard's API, used by the first-run screen and Settings > Import:
 *
 *   listSources(home)            browsers and profiles on this Mac, and what each step will need
 *   countSource(home, ref)       how many of each data type a profile holds (no Keychain prompt)
 *   importSource(input)          import the chosen types with progress; a result per type
 *   importFile(input)            Safari's export ZIP, a password CSV, or a bookmarks HTML file
 *
 * Inputs from the UI are validated here; nothing else in src/import trusts them.
 */

import { readFileSync, statSync } from "node:fs";
import type { CdpConnection } from "../cdp/connection";
import { join } from "node:path";
import { applyImport, failure, type ApplyInput, type Progress, type Target, type TypeResult } from "./apply";
import { browserByKey, BROWSERS } from "./catalog";
import { detectSources, type Source } from "./detect";
import { parseBookmarksHtml } from "./files/bookmarks-html";
import { parsePasswordsCsv } from "./files/passwords-csv";
import type { Keychain } from "./keychain";
import { countAll, readerFor } from "./reader";
import { copyExtensionData } from "./chrome/extension-data";
import { readSafariExport } from "./safari/export-zip";
import { DATA_TYPES, ImportError, isDataType, type Counts, type DataType, type ImportData } from "./types";
import { writeAtomically } from "./write/atomic";

export type SourceRef = { readonly browser: string; readonly profile: string };

export type SourceSummary = {
  readonly browser: string;
  readonly name: string;
  readonly family: string;
  readonly access: Source["access"];
  readonly profiles: readonly { readonly id: string; readonly name: string; readonly lastImported?: number }[];
  readonly types: readonly DataType[];
  /** Said before importing: which types will make macOS ask for Keychain access or need Full Disk Access. */
  readonly needs: { readonly keychain: readonly DataType[]; readonly fullDiskAccess: readonly DataType[] };
  readonly unsupported: Partial<Record<DataType, string>>;
  /** Shown before a Keychain prompt: which item macOS will ask about, and to choose Allow. */
  readonly keychainHelp?: string;
};

export const FULL_DISK_ACCESS_HELP =
  "Safari's files are protected by macOS. Open System Settings > Privacy & Security > Full Disk Access, turn on Perch, then come back. Or, in Safari, choose File > Export Browsing Data to File and import that ZIP, which needs no extra access.";

export function keychainHelp(service: string): string {
  return `macOS will ask whether Perch may use "${service}". Choose Allow. Perch needs it only during this import, so Always Allow is not needed.`;
}

type ImportLog = Record<string, number>;
const logPath = (userDataDir: string) => join(userDataDir, "Perch Import", "imports.json");

function readLog(userDataDir: string | undefined): ImportLog {
  if (!userDataDir) return {};
  try {
    const json = JSON.parse(readFileSync(logPath(userDataDir), "utf8"));
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

export function listSources(home: string, userDataDir?: string): SourceSummary[] {
  const log = readLog(userDataDir);
  return detectSources(home, BROWSERS).map((s) => {
    const reader = readerFor(s.browser, s.profiles[0] ?? { id: "", name: "", path: "" });
    return {
      browser: s.browser.key,
      name: s.browser.name,
      family: s.browser.family,
      access: s.access,
      profiles: s.profiles.map((p) => ({ id: p.id, name: p.name, ...(log[`${s.browser.key}/${p.id}`] ? { lastImported: log[`${s.browser.key}/${p.id}`] } : {}) })),
      types: reader.types,
      needs: { keychain: reader.needsKeychain, fullDiskAccess: reader.needsFullDiskAccess },
      unsupported: reader.unsupported,
      ...(reader.needsKeychain.length && s.browser.safeStorage?.[0] ? { keychainHelp: keychainHelp(s.browser.safeStorage[0].service) } : {}),
    };
  });
}

function resolve(home: string, ref: SourceRef) {
  if (typeof ref?.browser !== "string" || typeof ref?.profile !== "string") throw new ImportError("Choose a browser and a profile.", "invalid");
  const browser = browserByKey(ref.browser);
  if (!browser) throw new ImportError(`Perch does not import from "${ref.browser}".`, "invalid");
  const source = detectSources(home, [browser])[0];
  if (source?.access === "full-disk-access") throw new ImportError(FULL_DISK_ACCESS_HELP, "full-disk-access");
  const profile = source?.profiles.find((p) => p.id === ref.profile);
  if (!profile) throw new ImportError(`${browser.name} has no profile named "${ref.profile}" on this Mac.`, "not-found");
  return { browser, profile, reader: readerFor(browser, profile) };
}

export async function countSource(home: string, ref: SourceRef): Promise<Counts> {
  return countAll(resolve(home, ref).reader);
}

export type ImportInput = {
  readonly home: string;
  readonly source: SourceRef;
  readonly types: readonly unknown[];
  readonly target: Target;
  readonly keychain: Keychain;
  readonly onProgress?: (p: Progress) => void;
  readonly now?: number;
  /** The DevTools pipe to the running Perch, when perchd holds one. */
  readonly running?: CdpConnection;
  /** Perch's browser, which applies the import bundle itself (apply.ts). */
  readonly browser?: ApplyInput["browser"];
  /** Perch's memory, skills and chats, for Aside's agent data (apply.ts); without it they are bundled. */
  readonly agent?: ApplyInput["agent"];
};

export type Report = { readonly source: SourceRef; readonly results: readonly TypeResult[]; readonly bundle?: { readonly id: string; readonly path: string } };

function validTypes(types: readonly unknown[]): DataType[] {
  if (!Array.isArray(types) || types.length === 0) throw new ImportError("Choose at least one kind of data to import.", "invalid");
  const bad = types.filter((t) => !isDataType(t));
  if (bad.length) throw new ImportError(`Unknown data type: ${bad.map(String).join(", ")}.`, "invalid");
  return DATA_TYPES.filter((t) => types.includes(t));
}

export async function importSource(input: ImportInput): Promise<Report> {
  const types = validTypes(input.types);
  const { browser, profile, reader } = resolve(input.home, input.source);
  const parts: { type: DataType; data: ImportData; skipped?: number }[] = [];
  const failed: TypeResult[] = [];
  for (const [index, type] of types.entries()) {
    const why = reader.unsupported[type] ?? (reader.types.includes(type) ? undefined : `${browser.name} does not have this kind of data.`);
    if (why) {
      failed.push({ type, status: "unavailable", count: 0, message: why });
      continue;
    }
    input.onProgress?.({ type, state: "reading", index, total: types.length });
    try {
      const r = await reader.read(type, input.keychain);
      parts.push({ type, data: r.data, ...(r.skipped ? { skipped: r.skipped } : {}) });
    } catch (error) {
      failed.push(failure(type, error));
      input.onProgress?.({ type, state: "failed", index, total: types.length });
    }
  }
  // Each extension's own data goes over before Perch installs it, so it starts as it was left.
  const extensions = parts.find((p) => p.type === "extensions")?.data.extensions;
  if (browser.family === "chromium" && extensions?.length) copyExtensionData(profile.path, join(input.target.userDataDir, input.target.profileDir ?? "Default"), extensions.map((e) => e.id));
  const applied = await applyImport({ target: input.target, keychain: input.keychain, source: { browser: browser.name, profile: profile.name }, parts, onProgress: input.onProgress, now: input.now, running: input.running, browser: input.browser, agent: input.agent });
  const order = (r: TypeResult) => types.indexOf(r.type);
  const results = [...applied.results, ...failed].sort((a, b) => order(a) - order(b));
  results.forEach((r, index) => input.onProgress?.({ type: r.type, state: r.status === "failed" ? "failed" : "done", index, total: types.length }));
  if (results.some((r) => r.status === "written" || r.status === "bundled")) recordImport(input.target.userDataDir, `${browser.key}/${profile.id}`, input.now ?? Date.now());
  return { source: input.source, results, ...(applied.bundle ? { bundle: applied.bundle } : {}) };
}

function recordImport(userDataDir: string, key: string, at: number): void {
  try {
    writeAtomically(logPath(userDataDir), JSON.stringify({ ...readLog(userDataDir), [key]: at }));
  } catch {
    // The log only powers "last imported" in the wizard; an import does not fail over it.
  }
}

export type FileInput = Omit<ImportInput, "source" | "types" | "home"> & { readonly path: string };

/** Safari's export ZIP, a password CSV, or a bookmarks HTML file, chosen by its extension. */
export async function importFile(input: FileInput): Promise<Report> {
  if (typeof input.path !== "string" || !input.path.startsWith("/")) throw new ImportError("Choose a file to import.", "invalid");
  const ext = input.path.toLowerCase().split(".").pop();
  const source = { browser: "file", profile: input.path.split("/").pop() ?? "" };
  let data: ImportData;
  let skipped = 0;
  if (ext === "zip") {
    const r = await readSafariExport(input.path);
    data = { ...(r.bookmarks ? { bookmarks: r.bookmarks } : {}), ...(r.history ? { history: r.history } : {}), ...(r.passwords ? { passwords: r.passwords } : {}) };
    skipped = r.skipped;
  } else if (ext === "csv" || ext === "html" || ext === "htm") {
    if (statSync(input.path).size > 50 * 1024 * 1024) throw new ImportError("This file is too large to be a browser export.", "invalid");
    const text = readFileSync(input.path, "utf8");
    if (ext === "csv") {
      const r = parsePasswordsCsv(text);
      data = { passwords: r.passwords };
      skipped = r.skipped;
    } else data = { bookmarks: parseBookmarksHtml(text) };
  } else throw new ImportError("Choose a Safari export (.zip), a passwords file (.csv) or a bookmarks file (.html).", "invalid");
  const parts = (Object.keys(data) as DataType[]).map((type) => ({ type, data: { [type]: data[type] } as ImportData, ...(type === "passwords" && skipped ? { skipped } : {}) }));
  // Names the "Imported from …" bookmarks folder.
  const from = ext === "zip" ? "Safari" : source.profile;
  const applied = await applyImport({ target: input.target, keychain: input.keychain, source: { browser: from, profile: source.profile }, parts, onProgress: input.onProgress, now: input.now, running: input.running, browser: input.browser });
  return { source, results: applied.results, ...(applied.bundle ? { bundle: applied.bundle } : {}) };
}
