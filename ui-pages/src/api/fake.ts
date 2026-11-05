/**
 * An in-memory PerchApi with sample data. It behaves the way perchd must: it validates input,
 * keeps secret values write-only, never saves a memory draft before "Save to memory", and
 * reports jobs as progress events. State is replaced, never mutated.
 */

import type {
  AboutInfo, Appearance, ChatSummary, DetectedBrowser, DraftFact, JobId, JobProgress, McpImportCandidate, McpServer, MemoryDoc,
  MemorySettings, NtpLayout, Onboarding, PerchApi, Permissions, PrivacySettings, Provider, Routine, RoutineInput, RoutineProposal,
  SetupSource, SiteData, Skill, TaskModel,
} from "../api";
import { DEFAULT_APPEARANCE } from "../theme/apply";
import { ACCENT_NAMES, THEME_NAMES } from "../theme/tokens";
import { IMPORT_KINDS, countOf } from "../lib/labels";
import {
  type Check, checkApiKey, checkCommand, checkEndpointUrl, checkMcpUrl, checkSecretName, checkSitePattern, checkSkillLocation, checkTime, checkTitle,
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
  memorySettings: MemorySettings;
  docs: readonly MemoryDoc[];
  draft: readonly DraftFact[];
  routines: readonly Routine[];
  proposals: readonly RoutineProposal[];
  browsers: readonly DetectedBrowser[];
  onboarding: Onboarding;
  about: AboutInfo;
};

export type FakeOptions = {
  /** Delay between job steps; 0 in tests. */
  readonly stepMs?: number;
  readonly appearance?: Partial<Appearance>;
  readonly onboarding?: Onboarding;
  /** Records navigation calls (submitQuery, openPage, …) so tests and the dev build can show them. */
  readonly onNavigate?: (what: string, detail: unknown) => void;
};

const must = <T>(check: Check<T>): T => {
  if (!check.ok) throw new Error(check.error);
  return check.value;
};

let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

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
    permissions: seed.PERMISSIONS,
    privacy: seed.PRIVACY,
    siteData: seed.SITE_DATA,
    memorySettings: seed.MEMORY_SETTINGS,
    docs: seed.MEMORY_DOCS,
    draft: [],
    routines: seed.ROUTINES,
    proposals: seed.PROPOSALS,
    browsers: seed.BROWSERS,
    onboarding: options.onboarding ?? { finished: false, done: [] },
    about: seed.ABOUT,
  };
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

  function runJob(steps: readonly string[], onDone: () => readonly string[]): JobId {
    const jobId = newId("job");
    const total = steps.length;
    emit({ jobId, state: "running", step: steps[0] ?? "", done: 0, total });
    steps.forEach((step, i) => {
      setTimeout(() => {
        emit({ jobId, state: "running", step, done: i + 1, total });
        if (i === total - 1) setTimeout(() => emit({ jobId, state: "done", step: "Done", done: total, total, summary: onDone() }), stepMs);
      }, stepMs * (i + 1));
    });
    return jobId;
  }

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
    return { ...input, title, prompt: input.prompt.trim() };
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
      const names = new Set(state.servers.map((s) => `${s.source}:${s.name}`));
      return seed.MCP_CANDIDATES.map((c): McpImportCandidate => ({ ...c, alreadyAdded: c.alreadyAdded || names.has(`${c.source}:${c.name}`) }));
    },
    async importMcpServers(keys) {
      const added = seed.MCP_CANDIDATES.filter((c) => keys.includes(c.key)).map((c): McpServer => ({
        id: newId("mcp"), name: c.name, transport: c.transport, target: c.target, source: c.source,
        tools: 0, readOnlyTools: 0, trusted: false, enabled: true, secretNames: c.secretNames,
      }));
      set({ servers: [...state.servers, ...added] });
      return added;
    },
    async addMcpServer(input) {
      const name = must(checkTitle(input.name, 60));
      const target = input.transport === "stdio" ? must(checkCommand(input.target)) : must(checkMcpUrl(input.target));
      const secretNames = input.secrets.map((s) => {
        if (!s.value) throw new Error(`Enter a value for ${s.name}`);
        return must(checkSecretName(s.name));
      });
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
      set({ permissions: { ...state.permissions, mode } });
      return state.permissions;
    },
    async addSiteRule(input) {
      const pattern = must(checkSitePattern(input.pattern));
      const others = state.permissions.siteRules.filter((r) => r.pattern !== pattern);
      set({ permissions: { ...state.permissions, siteRules: [...others, { id: newId("rule"), pattern, rule: input.rule }] } });
      return state.permissions;
    },
    async removeSiteRule(id) {
      set({ permissions: { ...state.permissions, siteRules: state.permissions.siteRules.filter((r) => r.id !== id) } });
      return state.permissions;
    },
    async setClientMode(id, mode) {
      set({ permissions: { ...state.permissions, clientRules: state.permissions.clientRules.map((c) => (c.id === id ? { ...c, mode } : c)) } });
      return state.permissions;
    },

    async getPrivacy() {
      return state.privacy;
    },
    async setPrivacy(patch) {
      if (patch.dohCustomUrl) must(checkEndpointUrl(patch.dohCustomUrl));
      set({ privacy: { ...state.privacy, ...patch } });
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

    async getMemorySettings() {
      return state.memorySettings;
    },
    async setMemorySettings(patch) {
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
    async listSetupSources() {
      return seed.SETUP_SOURCES;
    },
    async startProfileBuild(sourceIds) {
      if (sourceIds.length === 0) throw new Error("Turn on at least one source");
      const names = seed.SETUP_SOURCES.filter((s) => sourceIds.includes(s.id) && s.available);
      const steps = [...names.map((s) => `Reading ${s.name.charAt(0).toLowerCase()}${s.name.slice(1)}`), "Checking what is missing", "Draft ready"];
      return runJob(steps, () => {
        set({ draft: seed.DRAFT_FACTS });
        return [`${seed.DRAFT_FACTS.length} facts to review`];
      });
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
      return { fullDiskAccess: false };
    },
    async openFullDiskAccess() {
      navigate("system-settings", "full-disk-access");
    },
    async startImport(request) {
      if (request.kinds.length === 0) throw new Error("Pick at least one thing to import");
      const browser = state.browsers.find((b) => b.id === request.browser);
      if (!browser || !browser.profiles.some((p) => p.id === request.profile)) throw new Error("That browser profile wasn't found");
      const picked = browser.options.filter((o) => request.kinds.includes(o.kind) && o.available);
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
