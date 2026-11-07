/**
 * Everything the pages API and sidebar chats use inside Perch, opened for one profile under its
 * "Perch Agent" folder: the model registry, memory and routines with their scheduler, the MCP
 * manager and skills. Nothing slow blocks startup: memory and routines open and the MCP servers
 * connect in the background, and the model registry opens on first use.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLog, type AuditSink } from "../../agent/audit";
import type { PerchPaths } from "../../daemon/paths";
import { allowsModel, MODEL_NOT_ALLOWED, type PolicyError } from "../../policy/policy";
import type { PolicyWatcher } from "../../policy/watch";
import { providerAllowed } from "./models";
import type { Browser } from "../../browser/browser";
import type { CdpConnection } from "../../cdp/connection";
import { systemKeychain } from "../../config/keychain";
import { SettingsStore } from "../../config/store";
import type { ClientRegistry } from "../../daemon/clients";
import { macConfirm } from "../../daemon/confirm";
import { macKeychain as importKeychain } from "../../import/keychain";
import { readChromiumBookmarks, readChromiumHistory } from "../../memory/sources";
import { findImports } from "../../mcp-client/importers/sources";
import { describeLaunch } from "../../mcp-client/launch";
import { McpManager } from "../../mcp-client/manager";
import { RegistryStore } from "../../mcp-client/registry";
import { isProviderId } from "../../models/ids";
import { createModelRegistry, type ModelHandle, type ModelRegistry } from "../../models/registry";
import type { Model } from "../../models/types";
import { openPerchData, type PerchData } from "../../routines/service";
import { MacKeychain } from "../../secure/keychain";
import { SkillStore } from "../../skills/store";
import type { PagesCore, Windows } from "../app";
import type { ChatStore } from "../chats";
import { createPagesApi, type PagesApi } from "../pages-api";
import { AppError } from "../runs";
import type { Vault } from "../vault";
import { Jobs } from "./jobs";
import { PagesState } from "./state";

export type PageServicesOptions = {
  /** The browser's user data folder; Perch's own files go in its "Perch Agent" folder. */
  userDataDir: string;
  profile: string;
  vault: Vault;
  browser: Browser;
  conn: CdpConnection;
  clients: ClientRegistry;
  /** The profile's one audit log: the daemon, the sidebar and routines all write it. */
  audit: AuditLog;
  env: Record<string, string | undefined>;
  /** Company policy (spec 12.2) and problems to report beside it, such as an unwritable AuditLogPath. */
  policy?: PolicyWatcher;
  policyProblems?: () => readonly PolicyError[];
};

/** The profile's audit log, with every older log merged in on first use (spec 7.4). */
export function profileAuditLog(userDataDir: string, home: PerchPaths, mirror?: AuditSink): AuditLog {
  const base = join(userDataDir, "Perch Agent");
  return new AuditLog(join(base, "audit.jsonl"), {
    legacy: [join(base, "sidebar-audit.jsonl"), home.auditFile, ...home.legacyAuditFiles],
    ...(mirror ? { mirror } : {}),
  });
}

export type PageServices = {
  /** For `startApp({ pages })`. */
  pages: (core: PagesCore) => PagesApi;
  /** The audit log file the sidebar's outside agents write. */
  sidebarAudit: string;
  /** Memory for a sidebar chat. */
  chatMemory: () => Promise<Awaited<ReturnType<PerchData["chatMemory"]>>>;
  /** Hands over the app's chats and windows, for building the memory profile. */
  attach(app: { chats: ChatStore; windows: Windows }): void;
  stop(): Promise<void>;
};

function modelOf(handle: ModelHandle): Model {
  if (handle.kind === "model") return handle.model;
  throw new Error("Claude Code can't do this task from Perch yet. Pick another model for it in Settings → Models.");
}

export function openPageServices(opts: PageServicesOptions): PageServices {
  const base = join(opts.userDataDir, "Perch Agent");
  const profileDir = join(opts.userDataDir, opts.profile);
  const openUrl = async (url: string) => {
    await opts.conn.send("Target.createTarget", { url });
  };
  const settingsKeychain = systemKeychain();
  let registry: Promise<ModelRegistry> | null = null;
  const models = () => (registry ??= SettingsStore.open({ dir: base, keychain: settingsKeychain }).then((store) => createModelRegistry({ store, keychain: settingsKeychain })));

  let app: { chats: ChatStore; windows: Windows } | null = null;
  const data = openPerchData({
    dataDir: base,
    profile: opts.profile,
    models: {
      fast: async () => modelOf(await (await models()).modelFor("fast")),
      forRoutine: async (routine) => {
        const [provider, ...rest] = (routine.model ?? "").split(":");
        const r = await models();
        const handle = await r.modelFor(isProviderId(provider) && rest.length ? { provider, model: rest.join(":") } : "default");
        const policy = opts.policy?.current() ?? {};
        if (!providerAllowed(handle.provider, policy) || !allowsModel(handle.provider, handle.info.id, policy)) throw new Error(MODEL_NOT_ALLOWED);
        return modelOf(handle);
      },
    },
    browser: async () => opts.browser,
    audit: opts.audit,
    ...(opts.policy ? { policy: opts.policy } : {}),
    setupInputs: () => ({
      history: () => readChromiumHistory(profileDir, { now: new Date() }),
      bookmarks: () => readChromiumBookmarks(profileDir),
      tabs: async () => (app?.windows.tabs() ?? []).map((t) => ({ id: t.id, title: t.title, url: t.url })),
      chats: async () =>
        (app?.chats.list() ?? []).slice(0, 40).map((c) => ({ title: c.title, firstMessage: c.messages.find((m) => m.role === "user")?.text ?? "", date: c.createdAt })),
    }),
  }).then((d) => (d.start(), d));
  // A failure shows on the pages that need memory; the rest of Perch keeps working.
  data.catch((error: Error) => process.stderr.write(`perchd: memory and routines did not open: ${error.message}\n`));

  const secrets = new MacKeychain();
  const confirm = macConfirm();
  const mcpStore = new RegistryStore(join(base, "mcp-servers.enc"), secrets);
  const manager = new McpManager({ store: mcpStore, keychain: secrets, env: opts.env, openUrl, approveLaunch: (r) => confirm(describeLaunch(r)) });
  void manager.start().catch((error: Error) => process.stderr.write(`perchd: MCP servers did not start: ${error.message}\n`));
  const home = opts.env.HOME || homedir();

  return {
    sidebarAudit: opts.audit.path,
    chatMemory: async () => (await data).chatMemory(),
    attach(a) {
      app = a;
    },
    pages: (core) =>
      createPagesApi({
        chats: core.chats,
        runs: core.runs,
        setDefaults: core.setDefaults,
        jobs: new Jobs(core.emit),
        state: new PagesState(base, opts.vault),
        models: { registry: models, keychain: settingsKeychain, openUrl },
        mcp: { store: mcpStore, keychain: secrets, manager, findImports: () => findImports({ home, env: opts.env }) },
        skills: { store: new SkillStore(join(base, "skills"), secrets), home },
        clients: opts.clients,
        audit: opts.audit,
        ...(opts.policy ? { policy: opts.policy } : {}),
        ...(opts.policyProblems ? { policyProblems: opts.policyProblems } : {}),
        data: () => data.catch((error: Error) => Promise.reject(new AppError(`Perch couldn't open memory and routines: ${error.message}`, 503))),
        importer: { home, target: { userDataDir: opts.userDataDir }, keychain: importKeychain(), running: opts.conn },
      }),
    async stop() {
      await manager.close();
      (await data.catch(() => null))?.stop();
      if (registry) (await registry.catch(() => null))?.dispose();
    },
  };
}
