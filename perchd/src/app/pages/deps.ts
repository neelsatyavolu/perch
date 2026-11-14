/** What the pages API is built from: the app's stores and the modules each page delegates to. */

import type { ChatEffort, ComposerModel, PermissionMode } from "../../../../ui-pages/src/api";
import type { AuditLog } from "../../agent/audit";
import type { CdpConnection } from "../../cdp/connection";
import type { Keychain as SettingsKeychain } from "../../config/keychain";
import type { ClientRegistry } from "../../daemon/clients";
import type { Target } from "../../import/apply";
import type { ImportInput } from "../../import/wizard";
import type { BrowserSync } from "../../sync/browser-sync";
import type { Keychain as ImportKeychain } from "../../import/keychain";
import type { Found } from "../../mcp-client/importers/sources";
import type { McpManager } from "../../mcp-client/manager";
import type { RegistryStore } from "../../mcp-client/registry";
import type { ModelRegistry } from "../../models/registry";
import type { PolicyError, PolicyView } from "../../policy/policy";
import type { PerchData } from "../../routines/service";
import type { SecretStore } from "../../secure/keychain";
import type { OpRun } from "../../secure/onepassword";
import type { SkillStore } from "../../skills/store";
import type { ChatStore } from "../chats";
import type { RunManager } from "../runs";
import type { Jobs } from "./jobs";
import type { PagesState } from "./state";

export type PagesDeps = {
  chats: ChatStore;
  runs: RunManager;
  jobs: Jobs;
  /** Opens a page in a new tab behind the current one (the Build my memory chat). */
  openBackgroundTab?: (url: string) => Promise<void>;
  state: PagesState;
  /** Changes what new chats start with; the default permission mode lives in the pages' settings. */
  setDefaults?: (patch: { mode?: PermissionMode; model?: string; effort?: ChatEffort }) => void;
  /** The chat models and what a new chat starts with (the app's info). */
  chatInfo?: () => { models: readonly ComposerModel[]; defaults: { model: string; effort: ChatEffort; mode: PermissionMode } };
  models: {
    registry: () => Promise<ModelRegistry>;
    /** Where the registry keeps API keys; read only to show a key's last four characters. */
    keychain: SettingsKeychain;
    /** Opens a provider's sign-in page in a tab the person can see. */
    openUrl: (url: string) => Promise<void>;
    /**
     * Opens a sign-in page and watches its tab until it reaches an address `done` accepts; returns
     * that address and closes the tab, or null when the tab was closed or the time ran out first.
     * Claude's sign-in ends on a page that shows a code to copy, which Perch reads from the tab.
     */
    openAndWatch?: (url: string, done: (address: string) => boolean, timeoutMs: number) => Promise<string | null>;
    /** How long signIn waits for the sign-in page to finish. */
    signInTimeoutMs?: number;
  };
  mcp: {
    store: RegistryStore;
    keychain: SecretStore;
    manager: McpManager;
    /** Servers in the person's other apps (Claude Code, Codex, ...), for the import dialog. */
    findImports: () => Promise<Found>;
  };
  skills: { store: SkillStore; builtInDir?: string; home: string };
  clients: ClientRegistry;
  /** The profile's one audit log (spec 7.4): every client writes it. */
  audit: AuditLog;
  /** Memory and routines, opened in the background at startup. */
  data: () => Promise<PerchData>;
  importer: {
    /** Files picked in the browser's open panel (a passwords CSV), by id. */
    files?: { resolve(id: string): { readonly path: string; readonly name: string } };
    home: string;
    target: Target;
    keychain: ImportKeychain;
    running?: CdpConnection;
    browser?: ImportInput["browser"];
  };
  /** Runs 1Password's `op`; null when it isn't installed. Left out where perchd runs without Perch. */
  onePassword?: { run: OpRun | null };
  /** Sync over the browser's data (Settings › Sync); left out where perchd runs without Perch. */
  sync?: BrowserSync;
  now?: () => Date;
  /** Company policy (spec 12.2); left out on an unmanaged Mac and in most tests. */
  policy?: PolicyView & { errors?: () => readonly PolicyError[] };
  /** Problems outside the policy itself that perch://policy and Settings report, such as an unwritable AuditLogPath. */
  policyProblems?: () => readonly PolicyError[];
};
