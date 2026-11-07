/**
 * The Import page over the import wizard (src/import/wizard.ts): the browsers found on this Mac,
 * what each can bring in, and an import that reports progress as a job. Aside's memory, skills
 * and chats come from its agent folder, shown under Aside. Chosen files (a passwords CSV) need the
 * browser's file picker, which perchd can't read from yet.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserId, DetectedBrowser, ImportKind, ImportNeed, ImportOption, SystemAccess } from "../../../../ui-pages/src/api";
import type { TypeResult } from "../../import/apply";
import type { DataType } from "../../import/types";
import { importSource, listSources, type SourceSummary } from "../../import/wizard";
import { AppError } from "../runs";
import * as v from "../validate";
import { notYet, type Methods } from "./common";
import type { PagesDeps } from "./deps";

const BROWSERS: readonly BrowserId[] = ["aside", "chrome", "arc", "dia", "brave", "edge", "vivaldi", "opera", "helium", "safari", "firefox", "zen"];
const ASIDE_AGENT = "aside-agent";
const KINDS: Readonly<Record<ImportKind, { type: DataType | null; noun: string }>> = {
  tabs: { type: "tabs", noun: "tabs" },
  bookmarks: { type: "bookmarks", noun: "bookmarks" },
  history: { type: "history", noun: "history entries" },
  passwords: { type: "passwords", noun: "passwords" },
  cookies: { type: "cookies", noun: "sites with logins" },
  extensions: { type: "extensions", noun: "extensions" },
  settings: { type: "searchEngines", noun: "search engines" },
  "aside-memory": { type: "memory", noun: "memory pages" },
  "aside-skills": { type: "skills", noun: "skills" },
  "aside-chats": { type: "chats", noun: "chats" },
  "aside-preferences": { type: null, noun: "preferences" },
};
const BROWSER_KINDS: readonly ImportKind[] = ["tabs", "bookmarks", "history", "passwords", "cookies", "extensions", "settings"];
const AGENT_KINDS: readonly ImportKind[] = ["aside-memory", "aside-skills", "aside-chats"];
const ALL_KINDS = Object.keys(KINDS) as ImportKind[];

const nounOf = (type: DataType) => Object.values(KINDS).find((k) => k.type === type)?.noun ?? type;

function option(kind: ImportKind, s: SourceSummary): ImportOption {
  const type = KINDS[kind].type!;
  const needs: ImportNeed | undefined =
    s.access === "full-disk-access" || s.needs.fullDiskAccess.includes(type) ? "full-disk-access" : s.needs.keychain.includes(type) ? "keychain" : undefined;
  const available = s.access === "full-disk-access" || (s.types.includes(type) && !s.unsupported[type]);
  return { kind, available, ...(needs ? { needs } : {}) };
}

function summaryLine(r: TypeResult): string {
  const noun = nounOf(r.type);
  if (r.status === "written" || r.status === "bundled") return `${r.count.toLocaleString("en-US")} ${noun}${r.skipped ? `, ${r.skipped.toLocaleString("en-US")} skipped` : ""}`;
  if (r.status === "empty") return `No ${noun} found`;
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}: ${r.message ?? "not imported"}`;
}

/** Whether perchd may read a folder macOS keeps behind Full Disk Access; null when it isn't there. */
function readable(path: string): boolean | null {
  try {
    readdirSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : false;
  }
}

export function importPages(deps: PagesDeps): Methods<"detectBrowsers" | "getSystemAccess" | "startImport"> {
  const { home, target } = deps.importer;
  const sources = () => listSources(home, target.userDataDir);

  return {
    async detectBrowsers() {
      const all = sources();
      const agent = all.find((s) => s.browser === ASIDE_AGENT);
      return all
        .filter((s): s is SourceSummary & { browser: BrowserId } => (BROWSERS as readonly string[]).includes(s.browser))
        .map((s): DetectedBrowser => ({
          id: s.browser,
          name: s.name,
          profiles: s.profiles.map((p) => ({ id: p.id, name: p.name })),
          options: [...BROWSER_KINDS.map((k) => option(k, s)), ...(s.browser === "aside" && agent ? AGENT_KINDS.map((k) => option(k, agent)) : [])],
        }));
    },
    async getSystemAccess(): Promise<SystemAccess> {
      const lib = join(home, "Library");
      return { fullDiskAccess: readable(join(lib, "Safari")) ?? readable(join(lib, "Mail")) ?? true };
    },
    async startImport([request]) {
      const o = v.object(request, '"request"');
      v.onlyKeys(o, ["browser", "profile", "kinds", "passwordsCsv"]);
      const browser = v.oneOf(o.browser, "browser", BROWSERS);
      const profile = v.text(o.profile, "profile", 300);
      const kinds = [...new Set(v.list(o.kinds, "kinds", ALL_KINDS.length).map((k) => v.oneOf(k, "kinds", ALL_KINDS)))];
      if (kinds.length === 0) throw new AppError("Pick at least one thing to import");
      if (o.passwordsCsv !== undefined) notYet("Perch can't read a chosen passwords file yet. Untick Passwords, or import the file later.");
      const unbacked = kinds.find((k) => KINDS[k].type === null);
      if (unbacked) notYet("Perch can't bring in Aside's permission mode and model choices yet. Untick them to import the rest.");
      const all = sources();
      if (!all.find((s) => s.browser === browser)?.profiles.some((p) => p.id === profile)) throw new AppError("That browser profile wasn't found");
      const agent = all.find((s) => s.browser === ASIDE_AGENT);
      const types = (list: readonly ImportKind[]) => kinds.filter((k) => list.includes(k)).map((k) => KINDS[k].type!);
      const parts = [
        { source: { browser, profile }, types: types(BROWSER_KINDS) },
        ...(browser === "aside" && agent?.profiles[0] ? [{ source: { browser: ASIDE_AGENT, profile: agent.profiles[0].id }, types: types(AGENT_KINDS) }] : []),
      ].filter((p) => p.types.length > 0);
      const total = parts.reduce((n, p) => n + p.types.length, 0);
      if (total === 0) throw new AppError("Aside's memory, skills and chats weren't found on this Mac");
      return deps.jobs.start(total, `Importing ${nounOf(parts[0]!.types[0]!)}`, async (job) => {
        const results: TypeResult[] = [];
        let base = 0;
        for (const part of parts) {
          const report = await importSource({
            home, source: part.source, types: part.types, target, keychain: deps.importer.keychain, running: deps.importer.running,
            onProgress: (p) => job.step(`Importing ${nounOf(p.type)}`, base + p.index),
          });
          results.push(...report.results);
          base += part.types.length;
        }
        if (results.some((r) => r.status === "written" || r.status === "bundled")) await deps.state.update((s) => ({ ...s, imported: true }));
        else if (results.every((r) => r.status === "failed" || r.status === "unavailable")) throw new Error(results[0]?.message ?? "Nothing could be imported");
        job.finish(results.map(summaryLine));
      });
    },
  };
}
