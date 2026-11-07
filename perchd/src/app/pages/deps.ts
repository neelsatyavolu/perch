/** What the pages API is built from: the app's stores and the modules each page delegates to. */

import type { PermissionMode } from "../../../../ui-pages/src/api";
import type { AuditLog } from "../../agent/audit";
import type { CdpConnection } from "../../cdp/connection";
import type { Keychain as SettingsKeychain } from "../../config/keychain";
import type { ClientRegistry } from "../../daemon/clients";
import type { Target } from "../../import/apply";
import type { Keychain as ImportKeychain } from "../../import/keychain";
import type { Found } from "../../mcp-client/importers/sources";
import type { McpManager } from "../../mcp-client/manager";
import type { RegistryStore } from "../../mcp-client/registry";
import type { ModelRegistry } from "../../models/registry";
import type { PolicyError, PolicyView } from "../../policy/policy";
import type { PerchData } from "../../routines/service";
import type { SecretStore } from "../../secure/keychain";
import type { SkillStore } from "../../skills/store";
import type { ChatStore } from "../chats";
import type { RunManager } from "../runs";
import type { Jobs } from "./jobs";
import type { PagesState } from "./state";

export type PagesDeps = {
  chats: ChatStore;
  runs: RunManager;
  jobs: Jobs;
  state: PagesState;
  /** Changes what new chats start with; the default permission mode lives in the pages' settings. */
  setDefaults?: (patch: { mode: PermissionMode }) => void;
  models: {
    registry: () => Promise<ModelRegistry>;
    /** Where the registry keeps API keys; read only to show a key's last four characters. */
    keychain: SettingsKeychain;
    /** Opens a provider's sign-in page in a tab the person can see. */
    openUrl: (url: string) => Promise<void>;
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
    home: string;
    target: Target;
    keychain: ImportKeychain;
    running?: CdpConnection;
  };
  now?: () => Date;
  /** Company policy (spec 12.2); left out on an unmanaged Mac and in most tests. */
  policy?: PolicyView & { errors?: () => readonly PolicyError[] };
  /** Problems outside the policy itself that perch://policy and Settings report, such as an unwritable AuditLogPath. */
  policyProblems?: () => readonly PolicyError[];
};
