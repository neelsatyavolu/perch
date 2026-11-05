/**
 * The app API every Perch page talks to.
 *
 * perchd implements this interface (spec 7.1). The pages never touch disk, the Keychain or the
 * network themselves: they call these methods and show what comes back.
 *
 * Transport: the browser injects `window.perch = { call(method, args), subscribe(event, listener) }`
 * into Perch's own pages only. `src/api/rpc.ts` turns that into a `PerchApi`, so perchd answers
 * one JSON message per method below, named exactly as here, with the arguments as an array.
 * Job progress arrives as events named `job:<jobId>` carrying a `JobProgress`.
 *
 * Security rules the implementation keeps (spec 11.1):
 * - Secret values (API keys, MCP server env and header values) go in, never come back out.
 *   Read methods return only secret *names*. perchd stores the values in the Keychain.
 * - Every list is per profile; incognito windows never load the Memory page.
 *
 * `src/api/fake.ts` is an in-memory implementation with sample data, used in development and tests.
 */

import type { AccentName, DarkThemeName, ThemeName } from "./theme/tokens";

/* ---------- Shared ---------- */

/** ISO 8601 timestamp. */
export type Iso = string;
export type PageId = "newtab" | "settings" | "memory" | "routines" | "import" | "welcome";
export type JobId = string;
export type JobProgress = {
  readonly jobId: JobId;
  readonly state: "running" | "done" | "failed";
  /** Plain words for what is happening now, e.g. "Reading your calendar". */
  readonly step: string;
  readonly done: number;
  readonly total: number;
  /** Lines shown when the job finishes, e.g. "412 bookmarks". */
  readonly summary?: readonly string[];
  readonly error?: string;
};
export type Unsubscribe = () => void;

/* ---------- Appearance (spec 5.3, 6, DESIGN.md) ---------- */

export type Density = "comfortable" | "compact";
export type Appearance = {
  readonly theme: ThemeName;
  readonly accent: AccentName;
  /** Switch between `darkTheme` and Paper with macOS. */
  readonly matchSystem: boolean;
  readonly darkTheme: DarkThemeName;
  /** Hide the tab strip and bookmarks bar (spec 5.3). */
  readonly hideChrome: boolean;
  /** With chrome hidden, show it when the pointer reaches the top edge. */
  readonly revealOnHover: boolean;
  readonly density: Density;
};

/* ---------- New tab page (spec 5.5, DESIGN.md) ---------- */

export type ChatStatus = "idle" | "running" | "waiting";
export type ChatSummary = {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly updatedAt: Iso;
  readonly status: ChatStatus;
};
export type NtpSection = "recent" | "suggested";
export type NtpLayout = {
  readonly railOpen: boolean;
  readonly hidden: readonly NtpSection[];
  readonly recentTab: "chats" | "routines";
};
export type SuggestionIcon = "memory" | "routines" | "import" | "mail" | "calendar" | "task";
export type SuggestionAction = { readonly type: "open"; readonly page: PageId } | { readonly type: "ask"; readonly prompt: string };
export type Suggestion = {
  readonly id: string;
  /** "setup" cards disappear once done; after setup the list holds "task" cards to run. */
  readonly kind: "setup" | "task";
  readonly title: string;
  readonly detail: string;
  readonly icon: SuggestionIcon;
  readonly action: SuggestionAction;
};
export type SearchEngine = "brave" | "google";
export type Query = { readonly text: string; readonly mode: "search" | "ask"; readonly engine: SearchEngine };

/* ---------- Models (spec 7.3) ---------- */

export type ProviderId = "claude-code" | "chatgpt" | "grok" | "anthropic" | "openai" | "xai" | "gemini" | "openrouter" | "local";
export type ProviderState = "connected" | "signed-out" | "not-installed" | "error";
export type Provider = {
  readonly id: ProviderId;
  readonly name: string;
  readonly kind: "subscription" | "api-key" | "local";
  readonly detail: string;
  readonly state: ProviderState;
  /** Account or key hint shown after sign-in, e.g. "neel@…" or "key ending 4f2a". Never the key. */
  readonly account?: string;
  readonly message?: string;
};
export type ConnectInput =
  | { readonly kind: "api-key"; readonly provider: Exclude<ProviderId, "claude-code" | "chatgpt" | "grok" | "local">; readonly key: string }
  | { readonly kind: "endpoint"; readonly name: string; readonly baseUrl: string; readonly key?: string };
export type Model = {
  readonly id: string;
  readonly label: string;
  readonly provider: ProviderId;
  readonly vision: boolean;
  readonly imageGeneration: boolean;
};
export type TaskRole = "default" | "fast" | "standard" | "deep" | "visual" | "image";
export type Effort = "off" | "low" | "medium" | "high" | "max";
export type TaskModel = { readonly role: TaskRole; readonly modelId: string | null; readonly effort: Effort; readonly fast: boolean };

/* ---------- Skills and MCP (spec 7.5) ---------- */

export type McpTransport = "stdio" | "http" | "sse";
export type McpImportSource = "claude-code" | "codex" | "claude-desktop" | "cursor" | "grok";
export type McpServer = {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  /** The command line for stdio, the URL otherwise. */
  readonly target: string;
  readonly source: McpImportSource | "manual";
  readonly tools: number;
  readonly readOnlyTools: number;
  /** Trusted servers' tools run without approval; others count as risky (spec 7.4). */
  readonly trusted: boolean;
  readonly enabled: boolean;
  /** Names of env vars and headers kept in the Keychain. */
  readonly secretNames: readonly string[];
};
export type McpImportCandidate = {
  readonly key: string;
  readonly name: string;
  readonly source: McpImportSource;
  readonly configPath: string;
  readonly transport: McpTransport;
  readonly target: string;
  readonly secretNames: readonly string[];
  readonly alreadyAdded: boolean;
};
export type NewMcpServer = {
  readonly name: string;
  readonly transport: McpTransport;
  readonly target: string;
  readonly secrets: readonly { readonly name: string; readonly value: string }[];
};
export type SkillOrigin = "built-in" | "folder" | "url" | "git" | "aside";
export type Skill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly origin: SkillOrigin;
  readonly location?: string;
  readonly enabled: boolean;
};

/* ---------- Permissions (spec 7.4) ---------- */

export type PermissionMode = "ask" | "guard" | "skip";
export type SiteRuleKind = "allow" | "ask" | "never";
export type SiteRule = { readonly id: string; readonly pattern: string; readonly rule: SiteRuleKind };
export type ClientRule = { readonly id: string; readonly client: string; readonly mode: PermissionMode; readonly lastUsed?: Iso };
export type Permissions = {
  readonly mode: PermissionMode;
  readonly siteRules: readonly SiteRule[];
  readonly clientRules: readonly ClientRule[];
  /** Set when a company policy caps the mode (spec 12.2, MaxPermissionMode). */
  readonly maxMode: PermissionMode | null;
};

/* ---------- Privacy and security (spec 5.1, 5.9) ---------- */

export type DohProvider = "cloudflare" | "quad9" | "mullvad" | "custom";
export type BackgroundConnection = { readonly id: string; readonly label: string; readonly detail: string; readonly enabled: boolean };
export type PrivacySettings = {
  readonly contentBlocker: boolean;
  readonly cookieBanners: boolean;
  readonly trackingParams: boolean;
  readonly httpsOnly: boolean;
  readonly dnsOverHttps: boolean;
  readonly dohProvider: DohProvider;
  readonly dohCustomUrl: string;
  readonly fingerprinting: boolean;
  readonly thirdPartyCookies: "block" | "allow";
  /** Sites where the content blocker is off. */
  readonly blockerExceptions: readonly string[];
  readonly backgroundConnections: readonly BackgroundConnection[];
};
export type PrivacyPatch = Partial<Omit<PrivacySettings, "backgroundConnections" | "blockerExceptions">>;
export type SiteData = { readonly host: string; readonly bytes: number; readonly cookies: number; readonly lastUsed: Iso };

/* ---------- Memory (spec 8) ---------- */

export type MemoryFolder = "" | "users" | "people" | "companies" | "sites" | "projects" | "routines" | "concepts" | "episodic";
export type MemoryPage = { readonly path: string; readonly title: string; readonly folder: MemoryFolder; readonly updatedAt: Iso; readonly bytes: number };
export type MemoryDoc = { readonly path: string; readonly title: string; readonly body: string; readonly updatedAt: Iso };
export type MemorySettings = {
  readonly extraction: boolean;
  readonly historyExtraction: boolean;
  readonly dreaming: boolean;
  readonly lastDream?: Iso;
};
export type SetupSourceNeed = "full-disk-access" | "sign-in" | "export-file";
export type SetupSource = {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly on: boolean;
  readonly available: boolean;
  readonly needs?: SetupSourceNeed;
};
export type FactGroup = "about" | "people" | "places" | "writing" | "sites";
export type DraftFact = { readonly id: string; readonly group: FactGroup; readonly text: string; readonly source: string };

/* ---------- Routines (spec 8) ---------- */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Schedule =
  | { readonly kind: "daily"; readonly time: string; readonly days: readonly Weekday[] }
  | { readonly kind: "interval"; readonly hours: number }
  | { readonly kind: "trigger"; readonly event: string };
export type RoutineRun = { readonly at: Iso; readonly outcome: "ok" | "failed" | "waiting" };
export type Routine = {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly schedule: Schedule;
  readonly enabled: boolean;
  readonly lastRun?: RoutineRun;
  readonly nextRun?: Iso;
};
export type RoutineInput = { readonly id?: string; readonly title: string; readonly prompt: string; readonly schedule: Schedule };
export type RoutineProposal = { readonly id: string; readonly title: string; readonly prompt: string; readonly schedule: Schedule; readonly evidence: string };

/* ---------- Import (spec 10) ---------- */

export type BrowserId = "aside" | "chrome" | "arc" | "dia" | "brave" | "edge" | "vivaldi" | "opera" | "helium" | "safari" | "firefox" | "zen";
export type ImportKind =
  | "bookmarks" | "history" | "passwords" | "cookies" | "tabs" | "extensions" | "settings"
  | "aside-memory" | "aside-skills" | "aside-chats" | "aside-preferences";
export type ImportNeed = "full-disk-access" | "keychain" | "csv-export" | "primary-password";
export type ImportOption = { readonly kind: ImportKind; readonly available: boolean; readonly needs?: ImportNeed; readonly count?: number };
export type DetectedBrowser = {
  readonly id: BrowserId;
  readonly name: string;
  readonly profiles: readonly { readonly id: string; readonly name: string }[];
  readonly options: readonly ImportOption[];
};
export type ImportRequest = { readonly browser: BrowserId; readonly profile: string; readonly kinds: readonly ImportKind[] };
export type SystemAccess = { readonly fullDiskAccess: boolean };

/* ---------- Welcome and About ---------- */

export type OnboardingStep = "appearance" | "models" | "import" | "memory";
export type Onboarding = { readonly finished: boolean; readonly done: readonly OnboardingStep[] };
export type UpdateStatus = {
  readonly state: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";
  readonly version?: string;
  readonly message?: string;
};
export type AboutInfo = {
  readonly version: string;
  readonly chromium: string;
  readonly perchd: string;
  readonly channel: "stable" | "beta";
  readonly autoUpdate: boolean;
  readonly lastChecked?: Iso;
};

/* ---------- The interface ---------- */

export interface PerchApi {
  // Appearance
  getAppearance(): Promise<Appearance>;
  setAppearance(patch: Partial<Appearance>): Promise<Appearance>;

  // New tab page
  getNtpLayout(): Promise<NtpLayout>;
  setNtpLayout(patch: Partial<NtpLayout>): Promise<NtpLayout>;
  listChats(limit: number): Promise<readonly ChatSummary[]>;
  searchChats(text: string): Promise<readonly ChatSummary[]>;
  listSuggestions(): Promise<readonly Suggestion[]>;
  dismissSuggestion(id: string): Promise<void>;
  /** Search opens results in this tab; Ask starts a chat with the text. */
  submitQuery(query: Query): Promise<void>;
  openChat(id: string): Promise<void>;
  newChat(): Promise<void>;
  openPage(page: PageId, section?: string): Promise<void>;

  // Models
  listProviders(): Promise<readonly Provider[]>;
  /** Starts the provider's own sign-in (OAuth window, or Claude Code check) and resolves with the result. */
  signIn(id: ProviderId): Promise<Provider>;
  signOut(id: ProviderId): Promise<Provider>;
  /** The key goes to the Keychain; the returned provider carries only a hint. */
  connectProvider(input: ConnectInput): Promise<Provider>;
  listModels(): Promise<readonly Model[]>;
  getTaskModels(): Promise<readonly TaskModel[]>;
  setTaskModel(role: TaskRole, patch: Partial<Omit<TaskModel, "role">>): Promise<TaskModel>;

  // Skills and MCP
  listMcpServers(): Promise<readonly McpServer[]>;
  scanMcpImports(): Promise<readonly McpImportCandidate[]>;
  importMcpServers(keys: readonly string[]): Promise<readonly McpServer[]>;
  addMcpServer(input: NewMcpServer): Promise<McpServer>;
  updateMcpServer(id: string, patch: { readonly enabled?: boolean; readonly trusted?: boolean }): Promise<McpServer>;
  removeMcpServer(id: string): Promise<void>;
  listSkills(): Promise<readonly Skill[]>;
  addSkill(input: { readonly origin: Exclude<SkillOrigin, "built-in" | "aside">; readonly location: string }): Promise<Skill>;
  setSkillEnabled(id: string, enabled: boolean): Promise<Skill>;
  removeSkill(id: string): Promise<void>;

  // Permissions
  getPermissions(): Promise<Permissions>;
  setPermissionMode(mode: PermissionMode): Promise<Permissions>;
  addSiteRule(input: { readonly pattern: string; readonly rule: SiteRuleKind }): Promise<Permissions>;
  removeSiteRule(id: string): Promise<Permissions>;
  setClientMode(id: string, mode: PermissionMode): Promise<Permissions>;

  // Privacy and security
  getPrivacy(): Promise<PrivacySettings>;
  setPrivacy(patch: PrivacyPatch): Promise<PrivacySettings>;
  setBackgroundConnection(id: string, enabled: boolean): Promise<PrivacySettings>;
  removeBlockerException(host: string): Promise<PrivacySettings>;
  listSiteData(): Promise<readonly SiteData[]>;
  /** Clears the site's cookies, storage and cache ("Forget this site", spec 5.9). */
  forgetSite(host: string): Promise<void>;

  // Memory
  getMemorySettings(): Promise<MemorySettings>;
  setMemorySettings(patch: Partial<MemorySettings>): Promise<MemorySettings>;
  listMemoryPages(): Promise<readonly MemoryPage[]>;
  readMemoryPage(path: string): Promise<MemoryDoc>;
  writeMemoryPage(path: string, body: string): Promise<MemoryDoc>;
  deleteMemoryPage(path: string): Promise<void>;
  wipeMemory(): Promise<void>;
  listSetupSources(): Promise<readonly SetupSource[]>;
  startProfileBuild(sourceIds: readonly string[]): Promise<JobId>;
  /** The draft from the last build. Nothing in it is saved until saveProfileDraft. */
  getProfileDraft(): Promise<readonly DraftFact[]>;
  saveProfileDraft(facts: readonly DraftFact[]): Promise<{ readonly saved: number }>;
  discardProfileDraft(): Promise<void>;

  // Routines
  listRoutines(): Promise<readonly Routine[]>;
  saveRoutine(input: RoutineInput): Promise<Routine>;
  setRoutineEnabled(id: string, enabled: boolean): Promise<Routine>;
  deleteRoutine(id: string): Promise<void>;
  runRoutine(id: string): Promise<void>;
  /** Tasks done at least twice in the last 30 days, offered as routines (spec 8). */
  findRoutineProposals(): Promise<readonly RoutineProposal[]>;
  acceptProposal(id: string): Promise<Routine>;
  dismissProposal(id: string): Promise<void>;

  // Import
  detectBrowsers(): Promise<readonly DetectedBrowser[]>;
  getSystemAccess(): Promise<SystemAccess>;
  /** Opens System Settings at the Full Disk Access pane. */
  openFullDiskAccess(): Promise<void>;
  startImport(request: ImportRequest): Promise<JobId>;

  // Jobs (profile build, import)
  watchJob(id: JobId, listener: (progress: JobProgress) => void): Unsubscribe;

  // Welcome and About
  getOnboarding(): Promise<Onboarding>;
  completeOnboardingStep(step: OnboardingStep): Promise<Onboarding>;
  finishOnboarding(): Promise<Onboarding>;
  getAbout(): Promise<AboutInfo>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  setAutoUpdate(on: boolean): Promise<AboutInfo>;
}

/** Method names, for the RPC adapter and the transport's allow-list. */
export const API_METHODS = [
  "getAppearance", "setAppearance",
  "getNtpLayout", "setNtpLayout", "listChats", "searchChats", "listSuggestions", "dismissSuggestion", "submitQuery", "openChat", "newChat", "openPage",
  "listProviders", "signIn", "signOut", "connectProvider", "listModels", "getTaskModels", "setTaskModel",
  "listMcpServers", "scanMcpImports", "importMcpServers", "addMcpServer", "updateMcpServer", "removeMcpServer",
  "listSkills", "addSkill", "setSkillEnabled", "removeSkill",
  "getPermissions", "setPermissionMode", "addSiteRule", "removeSiteRule", "setClientMode",
  "getPrivacy", "setPrivacy", "setBackgroundConnection", "removeBlockerException", "listSiteData", "forgetSite",
  "getMemorySettings", "setMemorySettings", "listMemoryPages", "readMemoryPage", "writeMemoryPage", "deleteMemoryPage", "wipeMemory",
  "listSetupSources", "startProfileBuild", "getProfileDraft", "saveProfileDraft", "discardProfileDraft",
  "listRoutines", "saveRoutine", "setRoutineEnabled", "deleteRoutine", "runRoutine", "findRoutineProposals", "acceptProposal", "dismissProposal",
  "detectBrowsers", "getSystemAccess", "openFullDiskAccess", "startImport",
  "getOnboarding", "completeOnboardingStep", "finishOnboarding", "getAbout", "checkForUpdates", "installUpdate", "setAutoUpdate",
] as const satisfies readonly Exclude<keyof PerchApi, "watchJob">[];
