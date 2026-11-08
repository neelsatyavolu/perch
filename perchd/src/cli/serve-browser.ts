/**
 * `perch serve --browser-fds`: perchd inside Perch (spec 7.1). The browser starts it with CDP on
 * fds 3 and 4 and one line of settings on fd 5: the loopback port and token for the sidebar's app
 * API, the page origins allowed to call it, and the profile folder. perchd then serves the sidebar,
 * and its socket lets outside agents (`perch mcp`) work in the same browser. It exits when the
 * browser closes fd 5 or the CDP connection.
 */

import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Browser } from "../browser/browser";
import { adoptBrowserFds } from "../cdp/adopt";
import { startApp } from "../app/app";
import { macKeychain } from "../app/keychain";
import { PolicyAuditMirror } from "../agent/audit-mirror";
import { openPageServices, profileAuditLog } from "../app/pages/services";
import { allowedSidebarModels, SidebarRuns, sidebarModels, sidebarRunner } from "../app/sidebar-runner";
import { startPolicyWatcher } from "../policy/watch";
import { Vault } from "../app/vault";
import { startDaemon, type Daemon } from "../daemon/daemon";
import { SIDEBAR_CLIENT } from "../daemon/server";
import { BrowserLink } from "../app/browser-link";
import { PerchDomain } from "../browser/perch-domain";
import type { Tab } from "../browser/tab";
import { MacKeychain } from "../daemon/keychain";
import { perchPaths } from "../daemon/paths";
import type { CliIO } from "./io";

/** perchd serves one profile inside Perch for now. */
const PROFILE = "Default";

export type BrowserSettings = { port: number; token: string; browserToken: string; origins: string[]; dataDir: string };

export function parseBrowserSettings(line: string): BrowserSettings {
  const o = JSON.parse(line) as Record<string, unknown>;
  const port = o.port;
  if (o.op !== "app" || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad port");
  if (typeof o.token !== "string" || o.token.length < 32) throw new Error("bad token");
  if (typeof o.browserToken !== "string" || o.browserToken.length < 32 || o.browserToken === o.token) throw new Error("bad browser token");
  if (typeof o.dataDir !== "string" || !o.dataDir.startsWith("/")) throw new Error("bad data folder");
  const origins = Array.isArray(o.origins) ? o.origins.filter((x): x is string => typeof x === "string" && /^chrome(-untrusted)?:\/\/[a-z0-9.-]+$/.test(x)) : [];
  return { port, token: o.token, browserToken: o.browserToken, origins, dataDir: o.dataDir };
}

/** The first line on fd 5, and a promise that settles when the browser closes it. */
function readSettings(fd = 5): Promise<{ settings: BrowserSettings; closed: Promise<void> }> {
  const stream = createReadStream("", { fd });
  const closed = new Promise<void>((resolve) => {
    stream.once("close", () => resolve());
    stream.once("end", () => resolve());
    stream.once("error", () => resolve());
  });
  const lines = createInterface({ input: stream });
  return new Promise((resolve, reject) => {
    lines.once("line", (line) => {
      try {
        resolve({ settings: parseBrowserSettings(line), closed });
      } catch (error) {
        reject(error);
      }
    });
    void closed.then(() => reject(new Error("the browser closed the settings pipe")));
  });
}

/** How an agent starts `perch mcp`: this compiled binary, or bun with the CLI's source in development. */
export function perchCommand(execPath = process.execPath, dir = import.meta.dir): { command: string; args: string[] } {
  const compiled = dir.includes("$bunfs") || !/\/bun$/.test(execPath);
  return compiled ? { command: execPath, args: [] } : { command: execPath, args: ["run", join(dir, "main.ts")] };
}

export async function serveInBrowser(io: CliIO): Promise<number> {
  const { settings, closed } = await readSettings();
  const conn = adoptBrowserFds();
  const browser = await Browser.adopt(conn);
  const base = join(settings.dataDir, "Perch Agent");
  const keychain = io.keychain ?? new MacKeychain();
  const runs = new SidebarRuns();
  // Company policy (spec 12.2) and the profile's one audit log, shared by the daemon, the sidebar and routines.
  const policy = startPolicyWatcher();
  const mirror = new PolicyAuditMirror(policy);
  const audit = profileAuditLog(settings.dataDir, perchPaths(io.env), mirror);
  const policyProblems = () => {
    const problem = mirror.error();
    return problem ? [{ name: "AuditLogPath", message: problem }] : [];
  };
  // The perch dot, Ask and outside agents' approvals in the browser (src/app/browser-link.ts).
  let agentTabs: (chatId: string) => string[] = () => [];
  let driving: (chatId: string) => Tab | null = () => null;
  const link = new BrowserLink({ perch: new PerchDomain(conn), agentTabs: (chatId) => agentTabs(chatId), driving: (chatId) => driving(chatId), onError: io.stderr });
  const start = (env: Record<string, string | undefined>) =>
    startDaemon({
      paths: perchPaths(env),
      keychain,
      sealKeychain: io.keychain ? undefined : new MacKeychain("Perch registry"),
      launch: async () => browser,
      sidebar: (session) => runs.get(session),
      policy,
      audit,
      browser: link.approvals,
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
  const vault = await Vault.open(macKeychain(), PROFILE);
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
  });
  const app = await startApp({
    dataDir: join(base, "app"),
    vault,
    runner: sidebarRunner({ runs, perch: perchCommand(), home, auditPath: services.sidebarAudit, memory: services.chatMemory, policy }),
    models: allowedSidebarModels(sidebarModels(), policy.current()),
    allowedOrigins: settings.origins,
    listen: { port: settings.port },
    token: settings.token,
    browserToken: settings.browserToken,
    pages: services.pages,
    onStatus: link.onStatus,
    artifactScheme: browser.features.has("perch-artifact"),
  });
  services.attach(app);
  agentTabs = (chatId) => runs.sessionsFor(chatId).flatMap((s) => daemon.manager.get(SIDEBAR_CLIENT, s)?.tabIds() ?? []);
  driving = (chatId) => runs.sessionsFor(chatId).map((s) => daemon.manager.get(SIDEBAR_CLIENT, s)?.ctx?.tab ?? null).find((t) => t && !t.closed) ?? null;
  link.attach(app);
  io.stderr(`perchd ${process.pid}: connected to browser; app API on 127.0.0.1:${settings.port}; socket in ${home}\n`);
  await Promise.race([closed, conn.closed]);
  io.stderr("perchd: the browser went away; stopping\n");
  link.stop();
  await app.stop();
  await services.stop();
  await daemon.stop();
  policy.stop();
  return 0;
}
