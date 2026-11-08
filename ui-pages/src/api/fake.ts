/**
 * An in-memory PerchApi with sample data. It behaves the way perchd must: it validates input,
 * keeps secret values write-only, never saves a memory draft before "Save to memory", and
 * reports jobs as progress events. State is replaced, never mutated.
 */

import type {
  AboutInfo, Appearance, BuiltInExtension, ChatSummary, DetectedBrowser, DraftFact, FileChoice, FileKind, JobId, JobProgress, McpImportCandidate, McpServer,
  MemoryDoc, MemorySaverSettings, MemorySettings, NtpLayout, Onboarding, PerchApi, PermissionMode, Permissions, PolicyProblem, PrivacySettings, Provider, Routine, RoutineInput,
  RoutineProposal, SiteData, SleepRule, Skill, SystemAccess, TaskModel,
} from "../api";
import { DEFAULT_APPEARANCE } from "../theme/apply";
import { ACCENT_NAMES, THEME_NAMES } from "../theme/tokens";
import { IMPORT_KINDS, countOf, sleepRuleText } from "../lib/labels";
import { redactTarget } from "../lib/redact";
import {
  type Check, checkApiKey, checkCommand, checkDohUrl, checkEndpointUrl, checkMcpUrl, checkSecretName, checkSitePattern, checkSkillLocation,
  checkTime, checkTitle, checkTrigger,
} from "../lib/validate";
import * as seed from "./seed";

type State = {
  appearance: Appearance;
  layout: NtpLayout;
  chats: readonly ChatSummary[];
  setupDone: readonly string[];
  dismissed: readonly string[];
  providers: readonly Provider[];
  taskModels: readonly TaskModel[];
  servers: readonly McpServer[];
  skills: readonly Skill[];
  permissions: Permissions;
  privacy: PrivacySettings;
  siteData: readonly SiteData[];
  builtIns: readonly BuiltInExtension[];
  memorySaver: MemorySaverSettings;
  memorySettings: MemorySettings;
  docs: readonly MemoryDoc[];
  draft: readonly DraftFact[];
  routines: readonly Routine[];
  proposals: readonly RoutineProposal[];
  browsers: readonly DetectedBrowser[];
  onboarding: Onboarding;
  about: AboutInfo;
  files: readonly (FileChoice & { readonly kind: FileKind })[];
  buildJob: JobId | null;
};

export type FakeOptions = {
  /** Delay between job steps; 0 in tests. */
  readonly stepMs?: number;
  readonly appearance?: Partial<Appearance>;
  readonly onboarding?: Onboarding;
  /** Records navigation calls (submitQuery, openPage, …) so tests and the dev build can show them. */
  readonly onNavigate?: (what: string, detail: unknown) => void;
  readonly permissions?: Partial<Permissions>;
  readonly access?: SystemAccess;
  /** Makes every job fail at its last step with this message. */
  readonly failJobs?: string;
  /** What the open panel returns; by default the person picks a file. */
  readonly pickFile?: (kind: FileKind) => string | null;
  /** Perch policies in force, as perchd reports them (spec 12.2); none by default. */
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly policyErrors?: readonly PolicyProblem[];
};

/** MaxPermissionMode as perchd reports it in `Permissions.maxMode`. */
const policyMaxMode = (policy: FakeOptions["policy"]): Partial<Permissions> => {
  const max = policy?.MaxPermissionMode;
  return max === "ask" || max === "guard" || max === "skip" ? { maxMode: max } : {};
};

/** perchd's answer to a write a company policy locks. */
const MANAGED = "Managed by your organization";
/** As perchd writes CSV: a cell starting with = + - or @ gets a leading ' so it is never run as a formula. */
const csvCell = (raw: string): string => {
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const must = <T>(check: Check<T>): T => {
  if (!check.ok) throw new Error(check.error);
  return check.value;
};

const SLEEP_RULE_ERROR = "Use a domain like example.com, *.example.com, or a full URL.";
/** A dotted host name: "localhost" and bare words are not sites. */
const SITE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** As the browser reads a never-sleep rule: Lulltab's forms (spec 5.6). */
function parseSleepRule(input: string): SleepRule {
  const raw = input.trim();
  if (!raw || raw.length > 500 || /\s/.test(raw)) throw new Error(SLEEP_RULE_ERROR);
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(SLEEP_RULE_ERROR);
    }
    if (!SITE_HOST.test(url.hostname)) throw new Error(SLEEP_RULE_ERROR);
    // As the browser (memory_saver/sleep_rules.cc): a bare site is a host rule, anything longer a prefix.
    if ((url.pathname === "/" || url.pathname === "") && !url.search) {
      return { kind: "host", pattern: url.hostname.toLowerCase().replace(/^www\./, "") };
    }
    return { kind: "prefix", pattern: `${url.origin}${url.pathname}${url.search}`.replace(/\/$/, "") };
  }
  const exact = raw.startsWith("=");
  const wild = raw.startsWith("*.");
  const rest = raw.slice(exact ? 1 : wild ? 2 : 0);
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  if (!SITE_HOST.test(host) || (slash !== -1 && (exact || wild))) throw new Error(SLEEP_RULE_ERROR);
  if (slash !== -1) return { kind: "prefix", pattern: `${host}${rest.slice(slash)}` };
  return { kind: exact ? "host" : wild ? "wildcard" : "domain", pattern: host };
}

let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const MODE_ORDER: readonly PermissionMode[] = ["ask", "guard", "skip"];
const DEFAULT_FILE_NAMES: Readonly<Record<FileKind, string>> = { "memory-export": "export.zip", "passwords-csv": "Passwords.csv" };

export function createFakeApi(options: FakeOptions = {}): PerchApi {
  const stepMs = options.stepMs ?? 400;
  const navigate = options.onNavigate ?? (() => undefined);
  let state: State = {
    appearance: { ...DEFAULT_APPEARANCE, ...options.appearance },
    layout: { railOpen: true, hidden: [], recentTab: "chats" },
    chats: seed.CHATS,
    setupDone: [],
    dismissed: [],
    providers: seed.PROVIDERS,
    taskModels: seed.TASK_MODELS,
    servers: seed.MCP_SERVERS,
    skills: seed.SKILLS,
    permissions: { ...seed.PERMISSIONS, ...policyMaxMode(options.policy), ...options.permissions },
    privacy: seed.PRIVACY,
    siteData: seed.SITE_DATA,
    builtIns: (["perch", "backrow", "caveatly"] as const).map((name) => ({ name, enabled: true })),
    memorySaver: seed.MEMORY_SAVER,
    memorySettings: seed.MEMORY_SETTINGS,
    docs: seed.MEMORY_DOCS,
    draft: [],
    routines: seed.ROUTINES,
    proposals: seed.PROPOSALS,
    browsers: seed.BROWSERS,
    onboarding: options.onboarding ?? { finished: false, done: [] },
    about: seed.ABOUT,
    files: [],
    buildJob: null,
  };
  const memorySaverLocked = () => (options.policy?.BuiltInExtensions as { memorySaver?: unknown } | undefined)?.memorySaver !== undefined;
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
  };
  const jobs = new Map<JobId, JobProgress>();
  const listeners = new Map<JobId, Set<(p: JobProgress) => void>>();
  const emit = (p: JobProgress) => {
    jobs.set(p.jobId, p);
    for (const l of listeners.get(p.jobId) ?? []) l(p);
  };
  const markDone = (id: string) => {
    if (!state.setupDone.includes(id)) set({ setupDone: [...state.setupDone, id] });
  };

  function runJob(steps: readonly string[], onDone: () => readonly string[], onEnd: () => void = () => undefined): JobId {
    const jobId = newId("job");
    const total = steps.length;
    const end = () => {
      onEnd();
      if (options.failJobs) emit({ jobId, state: "failed", step: steps[total - 1] ?? "", done: total - 1, total, error: options.failJobs });
      else emit({ jobId, state: "done", step: "Done", done: total, total, summary: onDone() });
    };
    emit({ jobId, state: "running", step: steps[0] ?? "", done: 0, total });
    steps.forEach((step, i) => {
      setTimeout(() => {
        emit({ jobId, state: "running", step, done: i + 1, total });
        if (i === total - 1) setTimeout(end, stepMs);
      }, stepMs * (i + 1));
    });
    return jobId;
  }
  const checkMode = (mode: PermissionMode) => {
    const max = state.permissions.maxMode;
    if (!MODE_ORDER.includes(mode)) throw new Error("Unknown permission mode");
    if (max && MODE_ORDER.indexOf(mode) > MODE_ORDER.indexOf(max)) throw new Error(MANAGED);
  };
  const file = (id: string | undefined, kind: FileKind) => state.files.find((f) => f.id === id && f.kind === kind);
  /** Import candidates as perchd returns them: targets redacted, found tokens listed as Keychain names. */
  const candidates = () => {
    const names = new Set(state.servers.map((s) => `${s.source}:${s.name}`));
    return seed.MCP_CANDIDATES.map((c): McpImportCandidate => {
      const r = redactTarget(c.target);
      return {
        ...c, target: r.target, secretNames: [...c.secretNames, ...r.secrets.map((x) => x.name)],
        alreadyAdded: c.alreadyAdded || names.has(`${c.source}:${c.name}`),
      };
    });
  };

  const provider = (id: Provider["id"]) => {
    const p = state.providers.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown provider ${id}`);
    return p;
  };
  const replaceProvider = (next: Provider) => {
    set({ providers: state.providers.map((p) => (p.id === next.id ? next : p)) });
    return next;
  };
  const server = (id: string) => {
    const s = state.servers.find((x) => x.id === id);
    if (!s) throw new Error("That server was removed");
    return s;
  };
  const routine = (id: string) => {
    const r = state.routines.find((x) => x.id === id);
    if (!r) throw new Error("That routine was deleted");
    return r;
  };
  const checkRoutine = (input: RoutineInput): RoutineInput => {
    const title = must(checkTitle(input.title));
    if (!input.prompt.trim()) throw new Error("Say what the routine should do");
    const s = input.schedule;
    if (s.kind === "daily") {
      must(checkTime(s.time));
      if (s.days.length === 0) throw new Error("Pick at least one day");
    }
    if (s.kind === "interval" && !(Number.isInteger(s.hours) && s.hours >= 1 && s.hours <= 168)) throw new Error("Pick between 1 and 168 hours");
    const schedule = s.kind === "trigger" ? must(checkTrigger(s.event, s.match)) : s;
    return { ...input, title, prompt: input.prompt.trim(), schedule };
  };

  return {
    async getAppearance() {
      return state.appearance;
    },
    async setAppearance(patch) {
      if (patch.theme && !THEME_NAMES.includes(patch.theme)) throw new Error("Unknown theme");
      if (patch.darkTheme && (!THEME_NAMES.includes(patch.darkTheme) || patch.darkTheme === ("paper" as string))) throw new Error("Unknown theme");
      if (patch.accent && !ACCENT_NAMES.includes(patch.accent)) throw new Error("Unknown accent");
      set({ appearance: { ...state.appearance, ...patch } });
      return state.appearance;
    },

    async getNtpLayout() {
      return state.layout;
    },
    async setNtpLayout(patch) {
      set({ layout: { ...state.layout, ...patch } });
      return state.layout;
    },
    async listChats(limit) {
      return state.chats.slice(0, limit);
    },
    async searchChats(text) {
      const q = text.trim().toLowerCase();
      return q ? state.chats.filter((c) => `${c.title} ${c.snippet}`.toLowerCase().includes(q)) : state.chats;
    },
    async listSuggestions() {
      const setup = seed.SETUP_SUGGESTIONS.filter((s) => !state.setupDone.includes(s.id) && !state.dismissed.includes(s.id));
      const tasks = state.setupDone.includes("setup-memory") ? seed.TASK_SUGGESTIONS.filter((s) => !state.dismissed.includes(s.id)) : [];
      return [...setup, ...tasks].slice(0, 3);
    },
    async dismissSuggestion(id) {
      set({ dismissed: [...state.dismissed, id] });
    },
    async submitQuery(query) {
      if (!query.text.trim()) throw new Error("Type something to search or ask");
      navigate("query", query);
    },
    async openChat(id) {
      navigate("chat", id);
    },
    async newChat() {
      navigate("new-chat", null);
    },
    async openPage(page, section) {
      navigate("page", { page, section });
    },
    async chooseFile(kind) {
      const name = options.pickFile ? options.pickFile(kind) : DEFAULT_FILE_NAMES[kind];
      if (name === null) return null;
      const choice = { id: newId("file"), name };
      set({ files: [...state.files, { ...choice, kind }] });
      return choice;
    },

    async listProviders() {
      return state.providers;
    },
    async signIn(id) {
      const p = provider(id);
      if (p.kind !== "subscription") throw new Error(`${p.name} connects with a key or an endpoint`);
      return replaceProvider({ ...p, state: "connected", account: id === "claude-code" ? "Claude Code 2.4" : "neel@example.com", message: undefined });
    },
    async signOut(id) {
      const { account: _account, ...rest } = provider(id);
      return replaceProvider({ ...rest, state: "signed-out" });
    },
    async connectProvider(input) {
      if (input.kind === "api-key") {
        const key = must(checkApiKey(input.key));
        return replaceProvider({ ...provider(input.provider), state: "connected", account: `Key ending ${key.slice(-4)}` });
      }
      const url = must(checkEndpointUrl(input.baseUrl));
      if (input.key) must(checkApiKey(input.key));
      must(checkTitle(input.name, 60));
      return replaceProvider({ ...provider("local"), state: "connected", account: new URL(url).host });
    },
    async listModels() {
      const connected = new Set(state.providers.filter((p) => p.state === "connected").map((p) => p.id));
      return seed.MODELS.filter((m) => connected.has(m.provider));
    },
    async getTaskModels() {
      return state.taskModels;
    },
    async setTaskModel(role, patch) {
      if (patch.modelId && !seed.MODELS.some((m) => m.id === patch.modelId)) throw new Error("That model isn't available");
      const next = { ...state.taskModels.find((t) => t.role === role)!, ...patch };
      set({ taskModels: state.taskModels.map((t) => (t.role === role ? next : t)) });
      return next;
    },

    async listMcpServers() {
      return state.servers;
    },
    async scanMcpImports() {
      return candidates();
    },
    async importMcpServers(keys) {
      const added = candidates().filter((c) => keys.includes(c.key) && !c.alreadyAdded).map((c): McpServer => ({
        id: newId("mcp"), name: c.name, transport: c.transport, target: c.target, source: c.source,
        tools: 0, readOnlyTools: 0, trusted: false, enabled: true, secretNames: c.secretNames,
      }));
      set({ servers: [...state.servers, ...added] });
      return added;
    },
    async addMcpServer(input) {
      const name = must(checkTitle(input.name, 60));
      const typed = input.transport === "stdio" ? must(checkCommand(input.target)) : must(checkMcpUrl(input.target));
      const { target, secrets: found } = redactTarget(typed);
      const secretNames = [...input.secrets.map((s) => {
        if (!s.value) throw new Error(`Enter a value for ${s.name}`);
        return must(checkSecretName(s.name));
      }), ...found.map((s) => s.name)];
      const created: McpServer = { id: newId("mcp"), name, transport: input.transport, target, source: "manual", tools: 0, readOnlyTools: 0, trusted: false, enabled: true, secretNames };
      set({ servers: [...state.servers, created] });
      return created;
    },
    async updateMcpServer(id, patch) {
      const next = { ...server(id), ...patch };
      set({ servers: state.servers.map((s) => (s.id === id ? next : s)) });
      return next;
    },
    async removeMcpServer(id) {
      set({ servers: state.servers.filter((s) => s.id !== id) });
    },
    async listSkills() {
      return state.skills;
    },
    async addSkill(input) {
      const location = must(checkSkillLocation(input.origin, input.location));
      const name = location.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).at(-1) ?? "skill";
      const created: Skill = { id: newId("skill"), name, description: "Added from " + location, origin: input.origin, location, enabled: true };
      set({ skills: [...state.skills, created] });
      return created;
    },
    async setSkillEnabled(id, enabled) {
      const s = state.skills.find((x) => x.id === id);
      if (!s) throw new Error("That skill was removed");
      const next = { ...s, enabled };
      set({ skills: state.skills.map((x) => (x.id === id ? next : x)) });
      return next;
    },
    async removeSkill(id) {
      if (state.skills.find((s) => s.id === id)?.origin === "built-in") throw new Error("Built-in skills can be turned off, not removed");
      set({ skills: state.skills.filter((s) => s.id !== id) });
    },

    async getPermissions() {
      return state.permissions;
    },
    async setPermissionMode(mode) {
      checkMode(mode);
      set({ permissions: { ...state.permissions, mode } });
      return state.permissions;
    },
    async addSiteRule(input) {
      const pattern = must(checkSitePattern(input.pattern));
      const rules = state.permissions.siteRules;
      const siteRules = rules.some((r) => r.pattern === pattern)
        ? rules.map((r) => (r.pattern === pattern ? { ...r, rule: input.rule } : r))
        : [...rules, { id: newId("rule"), pattern, rule: input.rule }];
      set({ permissions: { ...state.permissions, siteRules } });
      return state.permissions;
    },
    async removeSiteRule(id) {
      set({ permissions: { ...state.permissions, siteRules: state.permissions.siteRules.filter((r) => r.id !== id) } });
      return state.permissions;
    },
    async setClientMode(id, mode) {
      checkMode(mode);
      set({ permissions: { ...state.permissions, clientRules: state.permissions.clientRules.map((c) => (c.id === id ? { ...c, mode } : c)) } });
      return state.permissions;
    },

    async getPrivacy() {
      return state.privacy;
    },
    async listAuditLog(query) {
      const older = query.before ? seed.AUDIT_LOG.filter((e) => e.at < query.before!) : seed.AUDIT_LOG;
      return older.slice(0, Math.max(0, Math.min(query.limit, 500)));
    },
    async exportAuditLog(format = "jsonl") {
      if (format !== "jsonl" && format !== "csv") throw new Error('"format" must be one of jsonl, csv');
      const entries = [...seed.AUDIT_LOG].reverse();
      const text = format === "csv"
        ? `${["at,client,tab,site,action,outcome", ...entries.map((e) => [e.at, e.client, e.tab, e.site, e.action, e.outcome].map(csvCell).join(","))].join("\r\n")}\r\n`
        : entries.map((e) => `${JSON.stringify(e)}\n`).join("");
      return { name: `perch-activity-2026-11-07.${format}`, type: format === "csv" ? "text/csv" : "application/x-ndjson", entries: entries.length, text };
    },
    async getPolicy() {
      const values = options.policy ?? {};
      return { managed: Object.keys(values).length > 0, values, errors: options.policyErrors ?? [] };
    },

    async setPrivacy(patch) {
      if (patch.dohCustomUrl) must(checkDohUrl(patch.dohCustomUrl));
      const next = { ...state.privacy, ...patch };
      if (next.dohProvider === "custom" && !checkDohUrl(next.dohCustomUrl).ok) throw new Error("Enter the resolver's https:// address first");
      set({ privacy: next });
      return state.privacy;
    },
    async setBackgroundConnection(id, enabled) {
      set({ privacy: { ...state.privacy, backgroundConnections: state.privacy.backgroundConnections.map((c) => (c.id === id ? { ...c, enabled } : c)) } });
      return state.privacy;
    },
    async removeBlockerException(host) {
      set({ privacy: { ...state.privacy, blockerExceptions: state.privacy.blockerExceptions.filter((h) => h !== host) } });
      return state.privacy;
    },
    async listSiteData() {
      return state.siteData;
    },
    async forgetSite(host) {
      set({ siteData: state.siteData.filter((s) => s.host !== host) });
    },
    async listBuiltInExtensions() {
      return state.builtIns;
    },
    async setBuiltInExtension(name, enabled) {
      if (!state.builtIns.some((b) => b.name === name)) throw new Error("Unknown built-in extension");
      set({ builtIns: state.builtIns.map((b) => (b.name === name ? { ...b, enabled } : b)) });
      return state.builtIns;
    },

    async getMemorySaver() {
      return state.memorySaver;
    },
    async setMemorySaver(patch) {
      if (memorySaverLocked()) throw new Error(MANAGED);
      const t = patch.timeoutMinutes;
      if (t !== undefined && !(Number.isInteger(t) && t >= 0 && t <= 1440)) throw new Error("Choose a time between 0 minutes and a day");
      const rules = patch.rules?.map((r) => parseSleepRule(sleepRuleText(r)));
      set({ memorySaver: { timeoutMinutes: t ?? state.memorySaver.timeoutMinutes, rules: rules ?? state.memorySaver.rules } });
      return state.memorySaver;
    },
    async addSleepRule(input) {
      if (memorySaverLocked()) throw new Error(MANAGED);
      const rule = parseSleepRule(input);
      const known = state.memorySaver.rules.some((r) => r.kind === rule.kind && r.pattern === rule.pattern);
      if (known) throw new Error("That site is already on the list.");
      set({ memorySaver: { ...state.memorySaver, rules: [...state.memorySaver.rules, rule] } });
      return state.memorySaver;
    },
    async listTabMemory() {
      return seed.TAB_MEMORY;
    },

    async getMemorySettings() {
      // As perchd: with memory off by policy, the switches show off whatever was chosen before.
      const off = options.policy?.MemoryEnabled === false;
      return off ? { ...state.memorySettings, extraction: false, historyExtraction: false, dreaming: false } : state.memorySettings;
    },
    async setMemorySettings(patch) {
      const off = options.policy?.MemoryEnabled === false || (patch.historyExtraction && options.policy?.HistoryExtractionEnabled === false);
      if (off && Object.values(patch).some((v) => v === true)) throw new Error(MANAGED);
      set({ memorySettings: { ...state.memorySettings, ...patch } });
      return state.memorySettings;
    },
    async listMemoryPages() {
      return state.docs.map((d) => ({
        path: d.path, title: d.title, updatedAt: d.updatedAt, bytes: new TextEncoder().encode(d.body).length,
        folder: (d.path.includes("/") ? d.path.split("/")[0] : "") as never,
      }));
    },
    async readMemoryPage(path) {
      const doc = state.docs.find((d) => d.path === path);
      if (!doc) throw new Error("That memory page was deleted");
      return doc;
    },
    async writeMemoryPage(path, body) {
      const doc = state.docs.find((d) => d.path === path);
      if (!doc) throw new Error("That memory page was deleted");
      const next = { ...doc, body, updatedAt: new Date().toISOString() };
      set({ docs: state.docs.map((d) => (d.path === path ? next : d)) });
      return next;
    },
    async deleteMemoryPage(path) {
      set({ docs: state.docs.filter((d) => d.path !== path) });
    },
    async wipeMemory() {
      set({ docs: [], draft: [] });
    },
    async listDreamLogs(limit) {
      return seed.DREAM_LOGS.slice(0, limit);
    },
    async listSetupSources() {
      return seed.SETUP_SOURCES;
    },
    async startProfileBuild(sourceIds, files = {}) {
      if (state.buildJob) throw new Error("A build is already running");
      if (sourceIds.length === 0) throw new Error("Turn on at least one source");
      const picked = seed.SETUP_SOURCES.filter((s) => sourceIds.includes(s.id));
      const blocked = picked.find((s) => !s.available);
      if (blocked) throw new Error(`${blocked.name} isn't available yet`);
      const missing = picked.find((s) => s.needs === "export-file" && !file(files[s.id], "memory-export"));
      if (missing) throw new Error(`Choose the export file for ${missing.name}, or turn it off`);
      const steps = [...picked.map((s) => `Reading ${s.name.charAt(0).toLowerCase()}${s.name.slice(1)}`), "Checking what is missing", "Draft ready"];
      const jobId = runJob(steps, () => {
        set({ draft: seed.DRAFT_FACTS });
        return [`${seed.DRAFT_FACTS.length} facts to review`];
      }, () => set({ buildJob: null }));
      set({ buildJob: jobId });
      return jobId;
    },
    async getProfileBuild() {
      return state.buildJob;
    },
    async getProfileDraft() {
      return state.draft;
    },
    async saveProfileDraft(facts) {
      const lines = facts.map((f) => `- ${f.text.trim()}`).filter((l) => l.length > 2);
      const user = state.docs.find((d) => d.path === "USER.md");
      const body = `${user?.body.trimEnd() ?? "# About you"}\n${lines.join("\n")}\n`;
      const nextUser: MemoryDoc = { path: "USER.md", title: "About you", body, updatedAt: new Date().toISOString() };
      set({ docs: [nextUser, ...state.docs.filter((d) => d.path !== "USER.md")], draft: [] });
      markDone("setup-memory");
      return { saved: lines.length };
    },
    async discardProfileDraft() {
      set({ draft: [] });
    },

    async listRoutines() {
      return state.routines;
    },
    async saveRoutine(input) {
      const clean = checkRoutine(input);
      if (clean.id) {
        const next = { ...routine(clean.id), title: clean.title, prompt: clean.prompt, schedule: clean.schedule };
        set({ routines: state.routines.map((r) => (r.id === clean.id ? next : r)) });
        return next;
      }
      const created: Routine = { id: newId("routine"), title: clean.title, prompt: clean.prompt, schedule: clean.schedule, enabled: true };
      set({ routines: [...state.routines, created] });
      markDone("setup-routines");
      return created;
    },
    async setRoutineEnabled(id, enabled) {
      const next = { ...routine(id), enabled };
      set({ routines: state.routines.map((r) => (r.id === id ? next : r)) });
      return next;
    },
    async deleteRoutine(id) {
      set({ routines: state.routines.filter((r) => r.id !== id) });
    },
    async runRoutine(id) {
      const next: Routine = { ...routine(id), lastRun: { at: new Date().toISOString(), outcome: "ok" } };
      set({ routines: state.routines.map((r) => (r.id === id ? next : r)) });
    },
    async findRoutineProposals() {
      return state.proposals;
    },
    async acceptProposal(id) {
      const p = state.proposals.find((x) => x.id === id);
      if (!p) throw new Error("That suggestion is gone");
      set({ proposals: state.proposals.filter((x) => x.id !== id) });
      const created: Routine = { id: newId("routine"), title: p.title, prompt: p.prompt, schedule: p.schedule, enabled: true };
      set({ routines: [...state.routines, created] });
      markDone("setup-routines");
      return created;
    },
    async dismissProposal(id) {
      set({ proposals: state.proposals.filter((x) => x.id !== id) });
    },

    async detectBrowsers() {
      return state.browsers;
    },
    async getSystemAccess() {
      return options.access ?? { fullDiskAccess: false };
    },
    async openFullDiskAccess() {
      navigate("system-settings", "full-disk-access");
    },
    async startImport(request) {
      if (request.kinds.length === 0) throw new Error("Pick at least one thing to import");
      const browser = state.browsers.find((b) => b.id === request.browser);
      if (!browser || !browser.profiles.some((p) => p.id === request.profile)) throw new Error("That browser profile wasn't found");
      const picked = browser.options.filter((o) => request.kinds.includes(o.kind) && o.available);
      if (picked.some((o) => o.needs === "csv-export") && !file(request.passwordsCsv, "passwords-csv")) {
        throw new Error("Choose the passwords file you exported, or untick Passwords");
      }
      const steps = picked.map((o) => `Importing ${IMPORT_KINDS[o.kind].label.toLowerCase()}`);
      return runJob(steps, () => {
        markDone("setup-import");
        return picked.map((o) => {
          const noun = IMPORT_KINDS[o.kind].noun;
          if (o.kind === "tabs" && o.count !== undefined) return `${countOf(o.count, noun)}, asleep until you open them`;
          return o.count !== undefined ? countOf(o.count, noun) : IMPORT_KINDS[o.kind].label;
        });
      });
    },

    async getJob(id) {
      return jobs.get(id) ?? null;
    },
    watchJob(id, listener) {
      const set_ = listeners.get(id) ?? new Set();
      listeners.set(id, set_);
      set_.add(listener);
      const current = jobs.get(id);
      if (current) queueMicrotask(() => listener(current));
      return () => {
        set_.delete(listener);
      };
    },

    async getOnboarding() {
      return state.onboarding;
    },
    async completeOnboardingStep(step) {
      const done = state.onboarding.done.includes(step) ? state.onboarding.done : [...state.onboarding.done, step];
      set({ onboarding: { ...state.onboarding, done } });
      return state.onboarding;
    },
    async finishOnboarding() {
      set({ onboarding: { ...state.onboarding, finished: true } });
      return state.onboarding;
    },
    async getAbout() {
      return state.about;
    },
    async checkForUpdates() {
      set({ about: { ...state.about, lastChecked: new Date().toISOString() } });
      return { state: "up-to-date", version: state.about.version };
    },
    async installUpdate() {
      return { state: "up-to-date", version: state.about.version };
    },
    async setAutoUpdate(on) {
      set({ about: { ...state.about, autoUpdate: on } });
      return state.about;
    },
  };
}
