/**
 * The app API every Perch page talks to.
 *
 * perchd implements this interface (spec 7.1). The pages never touch disk, the Keychain or the
 * network themselves: they call these methods and show what comes back.
 *
 * Transport: the browser injects `window.perch = { call(method, args), subscribe(event, listener) }`
 * into Perch's own pages only. `src/api/rpc.ts` turns that into a `PerchApi`, so perchd answers
 * one JSON message per method below, named exactly as here, with the arguments as an array.
 * Job progress arrives as events named `job:<jobId>` carrying a `JobProgress`. Events are not
 * replayed, so the adapter calls `getJob` right after subscribing (see `watchJob`).
 *
 * Security rules the implementation keeps (spec 11.1):
 * - Secret values (API keys, MCP server env and header values, and tokens found inside MCP
 *   command lines and URLs) go in, never come back out. Read methods return only secret *names*.
 *   perchd stores the values in the Keychain.
 * - Pages never name a file path. Files come from perchd's own open panel (`chooseFile`) and
 *   pages get an opaque id, so a page can't make perchd read an arbitrary file.
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
/** What a file picked in `chooseFile` is for; perchd filters its open panel to match. */
/** What the key helper reports about this profile's keys (spec 11.1). */
export type SecurityInfo = {
  /** The Perch Keys helper is in this build (false in development builds without it). */
  readonly available: boolean;
  /** Keys are wrapped by the Secure Enclave. False in builds signed without the provisioning profile. */
  readonly protected: boolean;
  /** This Mac has Perch data but no key for it (e.g. after Migration Assistant): restore needed. */
  readonly needsRestore: boolean;
};

export type FileKind = "memory-export" | "passwords-csv";
/** A file the person picked in perchd's open panel. `id` is opaque; the path stays in perchd. */
export type FileChoice = { readonly id: string; readonly name: string };

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
  /** Kept at the top of the list. */
  readonly pinned?: true;
  /** A reply the user hasn't seen yet. */
  readonly unread?: true;
  /** The last reply was an error. */
  readonly failed?: true;
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
/** A model a new chat can use, as the chat composer lists it. */
export type ComposerModel = { readonly id: string; readonly label: string; readonly provider: string; readonly efforts: readonly ChatEffort[] };
export type ChatEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** What a task asked from the new tab page starts with: its model, effort and permission mode. */
export type Composer = { readonly models: readonly ComposerModel[]; readonly model: string; readonly effort: ChatEffort; readonly mode: PermissionMode };

/* ---------- Models (spec 7.3) ---------- */

export type ProviderId = "claude" | "claude-code" | "chatgpt" | "grok" | "anthropic" | "openai" | "xai" | "gemini" | "openrouter" | "local";
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
  /** The provider's sign-in page is open and shows a code to paste back with finishSignIn (Claude). */
  readonly awaitingCode?: boolean;
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
  /**
   * The command line for stdio, the URL otherwise, always redacted. perchd finds tokens in
   * arguments (`--api-key x`, `--token=x`, `API_KEY=x`, values with known token prefixes such as
   * `sk-` or `ghp_`) and in URLs (a password in the URL, secret-named query parameters, path
   * segments with token prefixes), moves each value to the Keychain, puts `${NAME}` in its place
   * and adds NAME to `secretNames`. It substitutes the values back only when it starts the server.
   */
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
  /** Redacted the same way as `McpServer.target`, before it is returned for the preview. */
  readonly target: string;
  readonly secretNames: readonly string[];
  readonly alreadyAdded: boolean;
};
export type NewMcpServer = {
  readonly name: string;
  readonly transport: McpTransport;
  /** May contain tokens as typed; perchd redacts it as described on `McpServer.target`. */
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
  /**
   * Set when a company policy caps the mode (spec 12.2, MaxPermissionMode). Order: ask < guard < skip.
   * perchd rejects any mode above it, for new chats and for every outside client.
   */
  readonly maxMode: PermissionMode | null;
};
/** One agent action (spec 7.4). `outcome`: approved by the person, ran without needing approval, declined, or stopped by a site rule. */
export type AuditOutcome = "approved" | "ran" | "declined" | "blocked";
export type AuditEntry = {
  readonly id: string;
  readonly at: Iso;
  /** "Perch" for the sidebar and chats, otherwise the outside client, e.g. "perch CLI" or "Claude Code (MCP)". */
  readonly client: string;
  readonly tab: string;
  readonly site: string;
  /** Plain words, e.g. "Clicked Send" or "Filled the sign-in form". */
  readonly action: string;
  readonly outcome: AuditOutcome;
};
export type AuditQuery = { readonly limit: number; readonly before?: Iso };
export type AuditFormat = "jsonl" | "csv";
/** The whole log as a file's contents; the page saves it with a download link. */
export type AuditExport = { readonly name: string; readonly type: string; readonly entries: number; readonly text: string };

/* ---------- Company policy (spec 12.2) ---------- */

/** One policy problem: a value that failed its schema, or an AuditLogPath Perch cannot write. */
export type PolicyProblem = { readonly name: string; readonly message: string };
/**
 * The Perch policies in force, by policy name (enterprise/policies.json). `managed` is false on an
 * unmanaged Mac, and then nothing in Settings changes.
 */
export type PolicyState = { readonly managed: boolean; readonly values: Readonly<Record<string, unknown>>; readonly errors: readonly PolicyProblem[] };

/* ---------- Privacy and security (spec 5.1, 5.9) ---------- */

export type DohProvider = "cloudflare" | "quad9" | "mullvad" | "custom";
export type BackgroundConnection = { readonly id: string; readonly label: string; readonly detail: string; readonly enabled: boolean };
export type PrivacySettings = {
  readonly contentBlocker: boolean;
  readonly cookieBanners: boolean;
  readonly trackingParams: boolean;
  readonly httpsOnly: boolean;
  readonly dnsOverHttps: boolean;
  /** "custom" is only valid with an https `dohCustomUrl`; perchd rejects the patch otherwise. */
  readonly dohProvider: DohProvider;
  readonly dohCustomUrl: string;
  readonly fingerprinting: boolean;
  readonly thirdPartyCookies: "block" | "allow";
  /** Sites where the content blocker is off. */
  readonly blockerExceptions: readonly string[];
  readonly backgroundConnections: readonly BackgroundConnection[];
};
export type PrivacyPatch = Partial<Omit<PrivacySettings, "backgroundConnections" | "blockerExceptions">>;
/** An extension Perch ships built in: it can be turned off but not removed (spec 5.6, 5.7, 5.9). */
export type BuiltInName = "perch" | "backrow" | "caveatly";
export type BuiltInExtension = { readonly name: BuiltInName; readonly enabled: boolean };
/** `lastUsed` is left out when the browser doesn't know it. */
export type SiteData = { readonly host: string; readonly bytes: number; readonly cookies: number; readonly lastUsed?: Iso };

/* ---------- Memory saver (spec 5.6) ---------- */

/** Lulltab's never-sleep forms: `example.com`, `=host`, `*.example.com`, a path prefix, or one page. */
export type SleepRuleKind = "domain" | "host" | "wildcard" | "prefix" | "url";
export type SleepRule = { readonly kind: SleepRuleKind; readonly pattern: string };
/** timeoutMinutes 0 means memory saver is off. sleepPinned lets pinned tabs sleep too (off when left out). */
export type MemorySaverSettings = { readonly timeoutMinutes: number; readonly rules: readonly SleepRule[]; readonly sleepPinned?: boolean };
/** A loaded tab's memory; a sleeping tab reports bytes 0. */
export type TabMemory = { readonly title: string; readonly url: string; readonly bytes: number; readonly asleep: boolean };

/* ---------- Sync ---------- */

export type SyncDevice = { readonly id: string; readonly name: string; readonly kind: string; readonly lastSeen: string; readonly current: boolean };
/** Sync is on when this Mac has joined an account. lastError is a sentence for the page. */
export type SyncStatus = { readonly on: boolean; readonly lastSync: string | null; readonly lastError: string | null; readonly devices: readonly SyncDevice[] };
/** What this Mac shows to join: `qr` is the text the QR code encodes, `code` what a person types. */
export type SyncPairing = { readonly pairingId: string; readonly qr: string; readonly code: string; readonly expiresAt: string };

/* ---------- Command bar (⌘K) ---------- */

export type CommandBarKind = "tab" | "history" | "bookmark";
export type CommandBarResult = { readonly kind: CommandBarKind; readonly title: string; readonly url: string; readonly tabId?: number };
/** What the command bar runs: a tab (tabId), a history or bookmark URL, or a command id from the page's static list. */
export type CommandBarItem = { readonly kind: CommandBarKind | "command"; readonly url?: string; readonly tabId?: number; readonly id?: string };

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
/**
 * What a source needs before it can be read. "full-disk-access": the page offers
 * `openFullDiskAccess` and lists sources again when the person comes back. "export-file": the page
 * asks for the file with `chooseFile("memory-export")` when the source is switched on and passes
 * its id to `startProfileBuild`. "sign-in": the source's account is set up in Settings.
 */
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
/** What one overnight tidy did (spec 8, dreaming): counts plus plain lines such as "Merged two pages about Maya Chen". */
export type DreamLog = {
  readonly id: string;
  readonly at: Iso;
  readonly merged: number;
  readonly updated: number;
  readonly archived: number;
  readonly lines: readonly string[];
};

/* ---------- Routines (spec 8) ---------- */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
/**
 * Events a routine can run on. `match` narrows it: for "mail-received" a sender or word in the
 * subject (optional); for "site-opened" a site pattern in the site-rule format (required).
 */
export type TriggerEvent = "mail-received" | "site-opened" | "download-finished" | "browser-started";
export type Schedule =
  | { readonly kind: "daily"; readonly time: string; readonly days: readonly Weekday[] }
  | { readonly kind: "interval"; readonly hours: number }
  | { readonly kind: "trigger"; readonly event: TriggerEvent; readonly match?: string };
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
export type ImportRequest = {
  readonly browser: BrowserId;
  readonly profile: string;
  readonly kinds: readonly ImportKind[];
  /** A `chooseFile("passwords-csv")` id. Required when passwords are picked and their option needs "csv-export". */
  readonly passwordsCsv?: string;
};
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
  /** The model, effort and permission mode the next task starts with, and the models to pick from. */
  getComposer(): Promise<Composer>;
  setComposer(patch: Partial<Pick<Composer, "model" | "effort" | "mode">>): Promise<Composer>;
  openChat(id: string): Promise<void>;
  newChat(): Promise<void>;
  /**
   * Opens one of these pages in the current tab. `section` becomes the page URL's #fragment, which
   * the pages read: perch://settings#<section id>, perch://memory#setup, perch://routines#<routine id>,
   * perch://import#<browser id>.
   */
  openPage(page: PageId, section?: string): Promise<void>;
  /** Shows perchd's macOS open panel for this kind of file. Resolves null when the person cancels. */
  chooseFile(kind: FileKind): Promise<FileChoice | null>;

  // Models
  listProviders(): Promise<readonly Provider[]>;
  /** Starts the provider's own sign-in (OAuth window, or Claude Code check) and resolves with the result. */
  signIn(id: ProviderId): Promise<Provider>;
  /** Completes a sign-in whose page showed a code (Provider.awaitingCode). */
  finishSignIn(id: ProviderId, code: string): Promise<Provider>;
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
  /** Rejects a mode above `maxMode`. */
  setPermissionMode(mode: PermissionMode): Promise<Permissions>;
  /**
   * One rule per pattern: adding a rule for a pattern that already has one replaces it (and keeps
   * its place). The Permissions page changes a rule's kind this way.
   */
  addSiteRule(input: { readonly pattern: string; readonly rule: SiteRuleKind }): Promise<Permissions>;
  removeSiteRule(id: string): Promise<Permissions>;
  /** Rejects a mode above `maxMode`. */
  setClientMode(id: string, mode: PermissionMode): Promise<Permissions>;
  /** Newest first. */
  listAuditLog(query: AuditQuery): Promise<readonly AuditEntry[]>;
  /** The whole log, oldest first, as JSON lines (the default) or CSV; the page offers it as a download. */
  exportAuditLog(format?: AuditFormat): Promise<AuditExport>;

  // Company policy
  /** Which Perch policies are in force; perchd refuses every Settings write a policy locks. */
  getPolicy(): Promise<PolicyState>;

  // Privacy and security
  getPrivacy(): Promise<PrivacySettings>;
  setPrivacy(patch: PrivacyPatch): Promise<PrivacySettings>;
  setBackgroundConnection(id: string, enabled: boolean): Promise<PrivacySettings>;
  removeBlockerException(host: string): Promise<PrivacySettings>;
  listSiteData(): Promise<readonly SiteData[]>;
  /** Clears the site's cookies, storage and cache ("Forget this site", spec 5.9). */
  forgetSite(host: string): Promise<void>;
  listBuiltInExtensions(): Promise<readonly BuiltInExtension[]>;
  setBuiltInExtension(name: BuiltInName, enabled: boolean): Promise<readonly BuiltInExtension[]>;

  // Performance
  getMemorySaver(): Promise<MemorySaverSettings>;
  /** Any field left out stays as it is. Rejects with a sentence for a timeout below 0 or above 1440. */
  setMemorySaver(patch: { readonly timeoutMinutes?: number; readonly rules?: readonly SleepRule[]; readonly sleepPinned?: boolean }): Promise<MemorySaverSettings>;
  /** Parses what the person typed (Lulltab's forms) and adds it; rejects with a sentence when it can't be read. */
  addSleepRule(input: string): Promise<MemorySaverSettings>;
  listTabMemory(): Promise<readonly TabMemory[]>;

  // Command bar (chrome://perch-command-bar); the browser answers these
  /** Open tabs, history and bookmarks matching `text`, best first, at most 8 of each kind. Empty text: the open tabs. */
  queryCommandBar(text: string): Promise<readonly CommandBarResult[]>;
  /** Activates a tab (tabId), opens a URL in the current tab, or runs a command by its id from commands.ts. The browser then closes the bubble. */
  runCommandBarItem(item: CommandBarItem): Promise<void>;
  closeCommandBar(): Promise<void>;

  // Sync (bookmarks, history and open tabs; passwords and extensions later)
  getSync(): Promise<SyncStatus>;
  /** This Mac asks to join: show the QR and code; a Perch that already syncs approves it. */
  startSyncPairing(): Promise<SyncPairing>;
  /** Polls once: the new status when the other device approved, null while it waits. Rejects when the code expired. */
  checkSyncPairing(pairingId: string): Promise<SyncStatus | null>;
  syncNow(): Promise<SyncStatus>;
  removeSyncDevice(id: string): Promise<SyncStatus>;
  turnOffSync(): Promise<SyncStatus>;
  /**
   * The browser answers this after Touch ID (or the Mac's password); the one secret a page is
   * shown, because the person must write it down. Rejects with code "unavailable" in builds
   * without the key helper.
   */
  revealRecoveryKey(): Promise<string>;

  // Recovery and backup (spec 11.1); the browser answers these
  getSecurity(): Promise<SecurityInfo>;
  /** Save panel, then writes an encrypted backup of everything Perch keeps for this profile. saved:false = cancelled. */
  exportBackup(): Promise<{ readonly saved: boolean; readonly name?: string }>;
  /**
   * Restores this profile's key from the recovery key; with fromBackup, first asks for a backup file and restores its contents too. restored:false = file picker cancelled.
   * Rejects with code "wrong-key" (key doesn't match this profile/backup), "bad-backup" (not a Perch backup or damaged), "unavailable" (no key helper), or "failed".
   */
  restoreFromRecoveryKey(p: { recoveryKey: string; fromBackup: boolean; replaceData?: boolean }): Promise<{ readonly restored: boolean }>;
  /** For someone without the recovery key: sets this profile's old Perch data aside, untouched, and starts with a new key. */
  startFresh(): Promise<void>;

  // Memory
  getMemorySettings(): Promise<MemorySettings>;
  setMemorySettings(patch: Partial<MemorySettings>): Promise<MemorySettings>;
  listMemoryPages(): Promise<readonly MemoryPage[]>;
  readMemoryPage(path: string): Promise<MemoryDoc>;
  writeMemoryPage(path: string, body: string): Promise<MemoryDoc>;
  deleteMemoryPage(path: string): Promise<void>;
  wipeMemory(): Promise<void>;
  /** Newest first. */
  listDreamLogs(limit: number): Promise<readonly DreamLog[]>;
  listSetupSources(): Promise<readonly SetupSource[]>;
  /**
   * `files` maps a source id to a `chooseFile("memory-export")` id; every switched-on source whose
   * `needs` is "export-file" must have one. Rejects while another build is running.
   */
  startProfileBuild(sourceIds: readonly string[], files?: Readonly<Record<string, string>>): Promise<JobId>;
  /** The build that is still running, so a page opened again can follow it; null when none is. */
  getProfileBuild(): Promise<JobId | null>;
  /**
   * The draft from the last finished build, kept until it is saved or discarded, so the review
   * survives a reload or a closed tab. Nothing in it is saved until saveProfileDraft.
   */
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
  /** The job's latest progress; null when perchd doesn't know the id (for example after a restart). */
  getJob(id: JobId): Promise<JobProgress | null>;
  /**
   * Calls `listener` with the job's current state as soon as it is known, then on every change,
   * so a job that finished before the page subscribed is still seen. The RPC adapter does this by
   * subscribing to `job:<id>` first and then calling `getJob`.
   */
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
  "getNtpLayout", "setNtpLayout", "listChats", "searchChats", "listSuggestions", "dismissSuggestion", "submitQuery", "getComposer", "setComposer", "openChat", "newChat", "openPage",
  "chooseFile",
  "listProviders", "signIn", "finishSignIn", "signOut", "connectProvider", "listModels", "getTaskModels", "setTaskModel",
  "listMcpServers", "scanMcpImports", "importMcpServers", "addMcpServer", "updateMcpServer", "removeMcpServer",
  "listSkills", "addSkill", "setSkillEnabled", "removeSkill",
  "getPermissions", "setPermissionMode", "addSiteRule", "removeSiteRule", "setClientMode", "listAuditLog", "exportAuditLog", "getPolicy",
  "getPrivacy", "setPrivacy", "setBackgroundConnection", "removeBlockerException", "listSiteData", "forgetSite",
  "listBuiltInExtensions", "setBuiltInExtension",
  "getMemorySaver", "setMemorySaver", "addSleepRule", "listTabMemory",
  "queryCommandBar", "runCommandBarItem", "closeCommandBar",
  "getSync", "startSyncPairing", "checkSyncPairing", "syncNow", "removeSyncDevice", "turnOffSync", "revealRecoveryKey",
  "getSecurity", "exportBackup", "restoreFromRecoveryKey", "startFresh",
  "getMemorySettings", "setMemorySettings", "listMemoryPages", "readMemoryPage", "writeMemoryPage", "deleteMemoryPage", "wipeMemory",
  "listDreamLogs", "listSetupSources", "startProfileBuild", "getProfileBuild", "getProfileDraft", "saveProfileDraft", "discardProfileDraft",
  "listRoutines", "saveRoutine", "setRoutineEnabled", "deleteRoutine", "runRoutine", "findRoutineProposals", "acceptProposal", "dismissProposal",
  "detectBrowsers", "getSystemAccess", "openFullDiskAccess", "startImport", "getJob",
  "getOnboarding", "completeOnboardingStep", "finishOnboarding", "getAbout", "checkForUpdates", "installUpdate", "setAutoUpdate",
] as const satisfies readonly Exclude<keyof PerchApi, "watchJob">[];
