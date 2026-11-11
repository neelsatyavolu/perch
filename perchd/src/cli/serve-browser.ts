/**
 * `perch serve --browser-fds`: perchd inside Perch (spec 7.1). The browser starts it with CDP on
 * fds 3 and 4 and lines on fd 5 (secure/key-channel.ts): first the loopback port and token for the
 * sidebar's app API, the page origins allowed to call it and the profile folder, then each profile's
 * root key. perchd keeps its secrets in files sealed under keys derived from that root key, moving
 * them out of the older Keychain items on first run. perchd then serves the sidebar,
 * and its socket lets outside agents (`perch mcp`) work in the same browser. It exits when the
 * browser closes fd 5 or the CDP connection.
 */

import { pageTextContext, readPageText } from "../app/page-text";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Browser } from "../browser/browser";
import { adoptBrowserFds } from "../cdp/adopt";
import { startApp } from "../app/app";
import { macKeychain } from "../app/keychain";
import { PolicyAuditMirror } from "../agent/audit-mirror";
import { openPageServices, profileAuditLog } from "../app/pages/services";
import { allowedSidebarModels, SidebarRuns, sidebarModels, sidebarRunner } from "../app/sidebar-runner";
import { startPolicyWatcher } from "../policy/watch";
import { Vault } from "../app/vault";
import { startDaemon, type Daemon, type Outside } from "../daemon/daemon";
import { Tasks } from "../app/tasks";
import { CHAT_KEEP_MS, SIDEBAR_CLIENT } from "../daemon/server";
import { runTask } from "../agent/loop";
import { withoutPageText } from "../agent/audit-seal";
import type { OwnLoop } from "../app/sidebar-runner";
import { bundledModels, loadModels, type ModelCatalog } from "@neelsatyavolu/shared-ai-auth";

/** How often the chat models pick up a new sign-in, and how long a fetched catalog is kept. */
const SIGN_IN_CHECK_MS = 60_000;
const CATALOG_TTL_MS = 10 * 60_000;
import { BrowserLink } from "../app/browser-link";
import { PerchDomain } from "../browser/perch-domain";
import type { Tab } from "../browser/tab";
import { MacKeychain } from "../daemon/keychain";
import { perchPaths } from "../daemon/paths";
import { parseBrowserSettings as parseSettingsObject, readKeyChannel, type BrowserSettings } from "../secure/key-channel";
import { loopEffort } from "../app/effort";
import { browserSecrets } from "./browser-keys";
import type { CliIO } from "./io";

/** perchd serves one profile inside Perch for now. */
const PROFILE = "Default";

export type { BrowserSettings } from "../secure/key-channel";

/** The app line's checks, for a line given as text. */
export function parseBrowserSettings(line: string): BrowserSettings {
  return parseSettingsObject(JSON.parse(line) as Record<string, unknown>);
}

/** How an agent starts `perch mcp`: this compiled binary, or bun with the CLI's source in development. */
export function perchCommand(execPath = process.execPath, dir = import.meta.dir): { command: string; args: string[] } {
  const compiled = dir.includes("$bunfs") || !/\/bun$/.test(execPath);
  return compiled ? { command: execPath, args: [] } : { command: execPath, args: ["run", join(dir, "main.ts")] };
}

export async function serveInBrowser(io: CliIO): Promise<number> {
  // A stray rejection (a background timer, say) must not end perchd and with it the sidebar and chats.
  process.on("unhandledRejection", (error) => io.stderr(`perchd: unhandled rejection: ${String(error)}\n`));
  const channel = readKeyChannel(createReadStream("", { fd: 5 }), { onProblem: (m) => io.stderr(`${m}\n`) });
  const settings = await channel.settings;
  const closed = channel.closed;
  const conn = adoptBrowserFds();
  const browser = await Browser.adopt(conn);
  const base = join(settings.dataDir, "Perch Agent");
  const secrets = io.keychain ? null : await browserSecrets(channel, { profile: PROFILE, dataDir: settings.dataDir, clientsFile: perchPaths(io.env).clientsFile, log: io.stderr });
  const keychain = io.keychain ?? secrets?.clients() ?? new MacKeychain();
  const runs = new SidebarRuns();
  // Company policy (spec 12.2) and the profile's one audit log, shared by the daemon, the sidebar and routines.
  const policy = startPolicyWatcher();
  const mirror = new PolicyAuditMirror(policy);
  const vault = await Vault.open(secrets?.app() ?? macKeychain(), PROFILE);
  const audit = profileAuditLog(settings.dataDir, perchPaths(io.env), mirror, vault);
  const policyProblems = () => {
    const problem = mirror.error();
    return problem ? [{ name: "AuditLogPath", message: problem }] : [];
  };
  // The perch dot, Ask and outside agents' approvals in the browser (src/app/browser-link.ts).
  let agentTabs: (chatId: string) => string[] = () => [];
  // Tasks, memory and skills for outside clients, once the app is up.
  let outside: Outside | undefined;
  let ownLoop: OwnLoop = async function* () {
    yield { type: "error", message: "Perch is still starting. Try again in a moment." };
  };
  let driving: (chatId: string) => Tab | null = () => null;
  const link = new BrowserLink({ perch: new PerchDomain(conn), agentTabs: (chatId) => agentTabs(chatId), driving: (chatId) => driving(chatId), onError: io.stderr });
  const start = (env: Record<string, string | undefined>) =>
    startDaemon({
      paths: perchPaths(env),
      keychain,
      sealKeychain: io.keychain ? undefined : (secrets?.clientSeal() ?? new MacKeychain("Perch registry")),
      launch: async () => browser,
      sidebar: (session) => runs.get(session),
      policy,
      audit,
      browser: link.approvals,
      outside: () => outside,
    });
  let home = perchPaths(io.env).home;
  let daemon: Daemon;
  try {
    daemon = await start(io.env);
  } catch (error) {
    // Another perchd (a `perch serve` from a terminal) owns the usual socket: keep one of our own.
    io.stderr(`perchd: the usual socket is taken (${(error as Error).message}); using a private one\n`);
    home = join(base, "home");
    daemon = await start({ ...io.env, PERCH_HOME: home });
  }
  const services = openPageServices({
    userDataDir: settings.dataDir,
    profile: PROFILE,
    vault,
    browser,
    conn,
    clients: daemon.registry,
    audit,
    env: io.env,
    policy,
    policyProblems,
    ...(secrets ? { secrets: { settings: secrets.config(), mcp: secrets.secure(), memory: secrets.memory(), importer: secrets.importer() } } : {}),
  });
  // The chat models follow shared-ai-auth's catalog and the sign-ins in Settings → Models.
  let catalog: ModelCatalog = bundledModels;
  let chatModels = allowedSidebarModels(sidebarModels(catalog), policy.current());
  let catalogAt = 0;
  const refreshModels = async () => {
    if (Date.now() - catalogAt > CATALOG_TTL_MS) {
      catalog = await loadModels().catch(() => catalog);
      catalogAt = Date.now();
    }
    const signedIn = await services.signedIn().catch(() => []);
    chatModels = allowedSidebarModels(sidebarModels(catalog, signedIn), policy.current());
  };
  void refreshModels();
  const modelTimer = setInterval(() => void refreshModels(), SIGN_IN_CHECK_MS);
  const app = await startApp({
    dataDir: join(base, "app"),
    vault,
    runner: sidebarRunner({ runs, perch: perchCommand(), home, auditPath: services.sidebarAudit, memory: services.chatMemory, skills: services.skills, policy, ownLoop: (run) => ownLoop(run) }),
    models: () => chatModels,
    allowedOrigins: settings.origins,
    listen: { port: settings.port },
    token: settings.token,
    browserToken: settings.browserToken,
    pages: services.pages,
    onStatus: link.onStatus,
    nameChat: services.nameChat,
    pageText: async (targetId) => {
      const page = await readPageText(conn, targetId);
      return page ? pageTextContext(page) || null : null;
    },
    artifactScheme: browser.features.has("perch-artifact"),
  });
  services.attach(app);
  // A chat on a model Perch calls itself works in the chat's daemon session, like a CLI agent.
  ownLoop = async function* ({ input, provider, model, session, mode, memory, extras }) {
    const chosen = await services.chatModel(provider, model);
    if (typeof chosen === "string") {
      yield { type: "error", message: chosen };
      return;
    }
    const agent = daemon.manager.open({ client: SIDEBAR_CLIENT, session, agent: "Perch", title: "Sidebar", persistent: true, onEnd: "close" });
    if (input.tab?.targetId) await daemon.manager.borrow(agent, input.tab.targetId).catch(() => undefined);
    const lent = await daemon.manager.lend(agent);
    try {
      yield* runTask({
        model: chosen,
        browser,
        task: input.task,
        mode,
        effort: loopEffort(input.settings.effort),
        approve: input.approve,
        audit: input.incognito ? withoutPageText(audit) : audit,
        client: "sidebar",
        signal: input.signal,
        policy,
        ...(memory ? { memory } : {}),
        ...(extras ? { extraTools: extras } : {}),
        tabs: { ctx: lent.ctx, afterCall: lent.sync },
      });
    } finally {
      await daemon.manager.giveBack(agent);
      daemon.manager.scheduleEnd(agent, input.incognito ? 0 : CHAT_KEEP_MS);
    }
  };
  outside = { tasks: new Tasks(app), memory: services.memoryApi, skills: services.skills };
  agentTabs = (chatId) => runs.sessionsFor(chatId).flatMap((s) => daemon.manager.get(SIDEBAR_CLIENT, s)?.tabIds() ?? []);
  driving = (chatId) => runs.sessionsFor(chatId).map((s) => daemon.manager.get(SIDEBAR_CLIENT, s)?.ctx?.tab ?? null).find((t) => t && !t.closed) ?? null;
  link.attach(app);
  io.stderr(`perchd ${process.pid}: connected to browser; app API on 127.0.0.1:${settings.port}; socket in ${home}\n`);
  await Promise.race([closed, conn.closed]);
  io.stderr("perchd: the browser went away; stopping\n");
  link.stop();
  clearInterval(modelTimer);
  await app.stop();
  await services.stop();
  await daemon.stop();
  policy.stop();
  return 0;
}
