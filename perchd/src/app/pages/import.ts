/**
 * The Import page over the import wizard (src/import/wizard.ts): the browsers found on this Mac,
 * what each can bring in, and an import that reports progress as a job. Aside's memory, skills
 * and chats come from its agent folder, shown under Aside, and go into Perch's own memory, skill
 * and chat stores (import-agent.ts). Firefox doesn't share its passwords, so those come from a CSV
 * the person exports and picks in the browser's open panel (`chooseFile`). Safari's bookmarks,
 * history and passwords come from the ZIP its File > Export Browsing Data to File makes, which
 * covers every Safari profile and needs no Full Disk Access; its cookies need Full Disk Access.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserId, DetectedBrowser, ImportKind, ImportNeed, ImportOption, SystemAccess } from "../../../../ui-pages/src/api";
import { failure, type TypeResult } from "../../import/apply";
import type { DataType } from "../../import/types";
import { asideAccountInfo } from "../../import/detect";
import { browserIcon } from "../../import/icons";
import { importFile, importSource, listSources, type SourceSummary } from "../../import/wizard";
import { AppError } from "../runs";
import * as v from "../validate";
import { importAllowed } from "../../policy/policy";
import { managed, notYet, policyOf, type Methods } from "./common";
import type { PagesDeps } from "./deps";
import { agentWriter } from "./import-agent";

const BROWSERS: readonly BrowserId[] = [
  "aside", "chrome", "chrome-beta", "chrome-canary", "arc", "dia", "comet", "atlas", "brave", "edge", "vivaldi", "opera", "opera-gx", "helium", "chromium", "safari", "firefox", "zen",
];
/** Browsers that keep passwords to themselves; Perch reads an exported CSV instead. */
const CSV_PASSWORDS: ReadonlySet<string> = new Set(["firefox", "zen"]);
/** What Safari's export ZIP brings. */
const SAFARI_EXPORT: ReadonlySet<DataType> = new Set(["bookmarks", "history", "passwords"]);
const ASIDE_AGENT = "aside-agent";
/** `also`: types that ride along with the kind when the source has them. */
const KINDS: Readonly<Record<ImportKind, { type: DataType | null; noun: string; also?: readonly DataType[] }>> = {
  tabs: { type: "tabs", noun: "tabs" },
  bookmarks: { type: "bookmarks", noun: "bookmarks" },
  history: { type: "history", noun: "history entries" },
  passwords: { type: "passwords", noun: "passwords" },
  cookies: { type: "cookies", noun: "sites with logins" },
  extensions: { type: "extensions", noun: "extensions" },
  settings: { type: "searchEngines", noun: "search engines", also: ["addresses"] },
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
  if (type === "passwords" && CSV_PASSWORDS.has(s.browser)) return { kind, available: true, needs: "csv-export" };
  if (s.browser === "safari" && SAFARI_EXPORT.has(type)) return { kind, available: true, needs: "safari-export" };
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

const MAX_PROFILES = 20;
/** An Aside agent account with no Aside browser profile on this Mac: its memory, skills and chats only. */
const ACCOUNT_PREFIX = "account:";

/**
 * Aside's agent data shows under Aside even when Aside's browser data is gone: a source with no
 * browser profiles, whose accounts are listed as account-only profiles.
 */
function withAsideAgent(all: readonly SourceSummary[], agent: SourceSummary | undefined): SourceSummary[] {
  if (!agent || all.some((s) => s.browser === "aside")) return [...all];
  return [...all, { ...agent, browser: "aside", name: "Aside", profiles: [], types: [], needs: { keychain: [], fullDiskAccess: [] }, unsupported: {} }];
}

function asideInfo(home: string) {
  return asideAccountInfo(join(home, ".aside"));
}

/** The agent account an Aside browser profile uses: its binding, else Aside's current account, else the first. */
function accountOf(home: string, profileId: string, agent: SourceSummary): string | undefined {
  const ids = agent.profiles.map((p) => p.id);
  if (profileId.startsWith(ACCOUNT_PREFIX)) {
    const id = profileId.slice(ACCOUNT_PREFIX.length);
    return ids.includes(id) ? id : undefined;
  }
  const info = asideInfo(home);
  const bound = info.bindings.get(profileId);
  if (bound !== undefined && ids.includes(bound)) return bound;
  if (info.current !== undefined && ids.includes(info.current)) return info.current;
  return ids[0];
}

/**
 * Aside's profiles as the wizard shows them: each browser profile with the account it's signed in
 * to, then any account no profile uses, which brings only its memory, skills and chats.
 */
function asideProfiles(home: string, aside: SourceSummary, agent: SourceSummary | undefined): { id: string; name: string }[] {
  const accountName = (id: string | undefined) => agent?.profiles.find((p) => p.id === id)?.name;
  const browserProfiles = aside.profiles.map((p) => {
    const name = agent ? accountName(accountOf(home, p.id, agent)) : undefined;
    return { id: p.id, name: name && name !== p.name ? `${p.name} (${name})` : p.name };
  });
  const used = new Set(agent ? aside.profiles.map((p) => accountOf(home, p.id, agent)) : []);
  const accountOnly = (agent?.profiles ?? [])
    .filter((a) => !used.has(a.id))
    .map((a) => ({ id: `${ACCOUNT_PREFIX}${a.id}`, name: `${a.name}: memory, skills and chats` }));
  return [...browserProfiles, ...accountOnly];
}

/** The passwords CSV the person picked; only a .csv, and only one the browser registered. */
function passwordsFile(deps: PagesDeps, id: string): { path: string } {
  const files = deps.importer.files;
  if (!files) notYet("This build of Perch can't read a chosen file. Untick Passwords to import the rest.");
  const file = files.resolve(id);
  if (!file.path.toLowerCase().endsWith(".csv")) throw new AppError("Choose the .csv file you exported");
  return { path: file.path };
}

/** The ZIP Safari exported; only a .zip, and only one the browser registered. */
function safariExportFile(deps: PagesDeps, id: string): { path: string } {
  const files = deps.importer.files;
  if (!files) notYet("This build of Perch can't read a chosen file.");
  const file = files.resolve(id);
  if (!file.path.toLowerCase().endsWith(".zip")) throw new AppError("Choose the .zip file Safari exported");
  return { path: file.path };
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

/** The browser's own app icon, when its app is on this Mac. */
function withIcon(browser: string, home: string): { icon?: string } {
  const icon = browserIcon(browser, home);
  return icon ? { icon } : {};
}

export function importPages(deps: PagesDeps): Methods<"detectBrowsers" | "getSystemAccess" | "startImport"> {
  const { home, target } = deps.importer;
  const sources = () => listSources(home, target.userDataDir);

  return {
    async detectBrowsers() {
      const all = sources();
      const agent = all.find((s) => s.browser === ASIDE_AGENT);
      const policy = policyOf(deps);
      // A kind the company does not allow is shown as unavailable; a browser it does not allow is left out.
      const allowed = (browser: string) => (o: ImportOption): ImportOption => (importAllowed(browser, KINDS[o.kind].type ?? "", policy) ? o : { kind: o.kind, available: false });
      // The browser used most recently comes first, so the wizard starts on the one the person lives in.
      return withAsideAgent(all, agent)
        .filter((s): s is SourceSummary & { browser: BrowserId } => (BROWSERS as readonly string[]).includes(s.browser))
        .filter((s) => !policy.ImportEnabled?.browsers || policy.ImportEnabled.browsers.includes(s.browser))
        .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
        .map((s): DetectedBrowser => ({
          id: s.browser,
          name: s.name,
          ...(s.lastUsed ? { lastUsed: s.lastUsed } : {}),
          ...withIcon(s.browser, home),
          profiles: s.browser === "aside" ? asideProfiles(home, s, agent) : s.profiles.map((p) => ({ id: p.id, name: p.name })),
          options: [
            ...(s.browser === "aside" && s.profiles.length === 0 ? [] : BROWSER_KINDS.map((k) => option(k, s))),
            ...(s.browser === "aside" && agent ? AGENT_KINDS.map((k) => option(k, agent)) : []),
          ].map(allowed(s.browser)),
        }));
    },
    async getSystemAccess(): Promise<SystemAccess> {
      const lib = join(home, "Library");
      return { fullDiskAccess: readable(join(lib, "Safari")) ?? readable(join(lib, "Mail")) ?? true };
    },
    async startImport([request]) {
      const o = v.object(request, '"request"');
      v.onlyKeys(o, ["browser", "profile", "profiles", "kinds", "passwordsCsv", "safariExport"]);
      const browser = v.oneOf(o.browser, "browser", BROWSERS);
      // `profiles` imports several in one go; `profile` is the single one older pages send.
      const requested = [
        ...new Set(o.profiles !== undefined ? v.list(o.profiles, "profiles", MAX_PROFILES).map((p, i) => v.text(p, `profiles[${i}]`, 300)) : [v.text(o.profile, "profile", 300)]),
      ];
      if (requested.length === 0) throw new AppError("Pick at least one profile to import");
      const kinds = [...new Set(v.list(o.kinds, "kinds", ALL_KINDS.length).map((k) => v.oneOf(k, "kinds", ALL_KINDS)))];
      if (kinds.length === 0) throw new AppError("Pick at least one thing to import");
      const policy = policyOf(deps);
      if (kinds.some((k) => !importAllowed(browser, KINDS[k].type ?? "", policy))) managed("Your organization doesn't allow importing this.");
      const csvPasswords = CSV_PASSWORDS.has(browser) && kinds.includes("passwords");
      if (o.passwordsCsv !== undefined && !csvPasswords) throw new AppError("A passwords file goes with Firefox or Zen passwords only");
      if (csvPasswords && o.passwordsCsv === undefined) throw new AppError("Choose the passwords file you exported");
      const csv = csvPasswords ? passwordsFile(deps, v.id(o.passwordsCsv, "passwordsCsv")) : null;
      if (o.safariExport !== undefined && browser !== "safari") throw new AppError("Safari's export file goes with Safari only");
      if (browser === "safari" && kinds.includes("passwords") && o.safariExport === undefined) throw new AppError("Safari's passwords come from its export file. Choose it, or untick Passwords");
      const zip = o.safariExport !== undefined ? safariExportFile(deps, v.id(o.safariExport, "safariExport")) : null;
      // With the export, what it holds comes from it, for every Safari profile; the rest (cookies)
      // still comes from Safari's own files.
      const fromZip = zip ? kinds.map((k) => KINDS[k].type).filter((t): t is DataType => t !== null && SAFARI_EXPORT.has(t)) : [];
      const unbacked = kinds.find((k) => KINDS[k].type === null);
      if (unbacked) notYet("Perch can't bring in Aside's permission mode and model choices yet. Untick them to import the rest.");
      const all = sources();
      const agent = all.find((s) => s.browser === ASIDE_AGENT);
      const source = withAsideAgent(all, agent).find((s) => s.browser === browser);
      const shown = source ? (browser === "aside" ? asideProfiles(home, source, agent) : source.profiles) : [];
      const named = (id: string) => shown.find((p) => p.id === id)?.name ?? id;
      for (const id of requested) if (!shown.some((p) => p.id === id)) throw new AppError("That browser profile wasn't found");
      const has = (t: DataType) => Boolean(source?.types.includes(t) && !source.unsupported[t]);
      const types = (list: readonly ImportKind[]) =>
        kinds.filter((k) => list.includes(k) && !(csv && k === "passwords") && !fromZip.includes(KINDS[k].type!)).flatMap((k) => [KINDS[k].type!, ...(KINDS[k].also ?? []).filter(has)]);
      // Each profile brings its browser data; an Aside profile also brings the agent account it's
      // signed in to, and each account comes over once however many profiles share it.
      const accounts = new Set<string>();
      // The first browser profile comes into this Perch profile; each other one gets a Perch
      // profile of its own name, with its tabs, switched to from the profile menu.
      const browserProfiles = requested.filter((id) => !id.startsWith(ACCOUNT_PREFIX));
      const parts: { source: { browser: string; profile: string }; types: DataType[]; label?: string; intoProfile?: string }[] = requested.flatMap((id) => {
        const label = requested.length > 1 ? named(id) : undefined;
        const account = browser === "aside" && agent ? accountOf(home, id, agent) : undefined;
        const agentPart = account !== undefined && !accounts.has(account) ? (accounts.add(account), [{ source: { browser: ASIDE_AGENT, profile: account }, types: types(AGENT_KINDS), label }]) : [];
        const own = browserProfiles.indexOf(id) > 0 ? { intoProfile: named(id) } : {};
        const browserPart = id.startsWith(ACCOUNT_PREFIX) ? [] : [{ source: { browser, profile: id }, types: types(BROWSER_KINDS), label, ...own }];
        return [...browserPart, ...agentPart];
      }).filter((p) => p.types.length > 0);
      const total = parts.reduce((n, p) => n + p.types.length, 0) + (csv ? 1 : 0) + fromZip.length;
      if (total === 0) throw new AppError(browser === "aside" ? "Aside's memory, skills and chats weren't found on this Mac" : "There is nothing to import from that profile");
      return deps.jobs.start(total, `Importing ${nounOf(parts[0]?.types[0] ?? "passwords")}`, async (job) => {
        const lines: string[] = [];
        const results: TypeResult[] = [];
        let base = 0;
        for (const part of parts) {
          // A browser whose files can't be read (Safari without Full Disk Access) still lets the
          // passwords file and the other parts come in; its types report the reason.
          const report = await importSource({
            home, source: part.source, types: part.types, target, keychain: deps.importer.keychain, running: deps.importer.running, browser: deps.importer.browser, agent: agentWriter(deps),
            ...(part.intoProfile ? { intoProfile: part.intoProfile } : {}),
            onProgress: (p) => job.step(`Importing ${nounOf(p.type)}${part.label ? ` from ${part.label}` : ""}`, base + p.index),
          }).catch((error: unknown) => (csv || zip || parts.length > 1 ? { results: part.types.map((t) => failure(t, error)) } : Promise.reject(error)));
          results.push(...report.results);
          lines.push(...report.results.map((r) => (part.label ? `${part.label}: ${summaryLine(r)}` : summaryLine(r))));
          if (part.intoProfile && report.results.some((r) => r.status === "written")) lines.push(`${part.label}: added as its own Perch profile, "${part.intoProfile}"; switch to it from the profile menu`);
          base += part.types.length;
        }
        if (zip) {
          job.step(`Importing ${nounOf(fromZip[0]!)}`, base);
          const report = await importFile({
            path: zip.path, types: fromZip, target, keychain: deps.importer.keychain, running: deps.importer.running, browser: deps.importer.browser,
            onProgress: (p) => job.step(`Importing ${nounOf(p.type)}`, base + p.index),
          }).catch((error: unknown) => ({ results: fromZip.map((t) => failure(t, error)) }));
          results.push(...report.results);
          lines.push(...report.results.map(summaryLine));
          base += fromZip.length;
        }
        if (csv) {
          job.step("Importing passwords", base);
          const report = await importFile({ path: csv.path, target, keychain: deps.importer.keychain, running: deps.importer.running, browser: deps.importer.browser })
            .catch((error: unknown) => ({ results: [failure("passwords", error)] }));
          results.push(...report.results);
          lines.push(...report.results.map(summaryLine));
        }
        if (results.some((r) => r.status === "written" || r.status === "bundled")) await deps.state.update((s) => ({ ...s, imported: true }));
        else if (results.every((r) => r.status === "failed" || r.status === "unavailable")) throw new Error(results[0]?.message ?? "Nothing could be imported");
        job.finish(lines);
      });
    },
  };
}
