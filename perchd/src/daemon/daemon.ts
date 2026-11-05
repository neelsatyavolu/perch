/**
 * perchd as a long-running process: one browser, the client socket and the agent sessions.
 * Inside Perch the browser starts it (plan 3b); until then `perch` starts it on first use.
 */

import { existsSync } from "node:fs";
import { AuditLog } from "../agent/audit";
import { TOOL_SPECS } from "../agent/tools";
import { Browser } from "../browser/browser";
import { ClientRegistry, isMode } from "./clients";
import type { Keychain } from "./keychain";
import type { PerchPaths } from "./paths";
import { SESSION_ID, type OnEnd } from "./protocol";
import { startServer, type Connection, type Handler } from "./server";
import { cdpTabGroups, SessionManager, type AgentSession, type TabGroups } from "./sessions";

export const VERSION = "0.1.0";
export const PERCH_APP = "/Applications/Perch.app";
export const PERCH_BUNDLE_ID = "co.xanom.perch";

export type DaemonOptions = {
  paths: PerchPaths;
  keychain: Keychain;
  launch: () => Promise<Browser>;
  groups?: TabGroups;
  graceMs?: number;
  helloTimeoutMs?: number;
  idleSleepMs?: number;
  approvalTimeoutMs?: number;
};

export type Daemon = { manager: SessionManager; registry: ClientRegistry; stop(): Promise<void> };

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

/** Only the owner's own terminal (client "cli") may change other clients. */
function adminOnly(conn: Connection): void {
  if (conn.client.name !== "cli") throw new Error("Only the perch command can change clients.");
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  let browser: Promise<Browser> | null = null;
  const registry = new ClientRegistry(opts.paths.clientsFile, opts.keychain);
  const audit = new AuditLog(opts.paths.auditFile);
  const getBrowser = (): Promise<Browser> =>
    (browser ??= opts
      .launch()
      .then((b) => {
        // The user closed the browser: its tabs are gone, so are the sessions; the next call starts it again.
        void b.conn.closed.then(() => {
          browser = null;
          manager.forgetAll();
        });
        return b;
      })
      .catch((error) => {
        browser = null;
        throw error;
      }));
  const manager = new SessionManager({ browser: getBrowser, sessionsFile: opts.paths.sessionsFile, groups: opts.groups ?? cdpTabGroups(getBrowser), idleSleepMs: opts.idleSleepMs });

  /** The caller's own session, or another of the same client's sessions by id. */
  const sessionOf = (conn: Connection, params: Record<string, unknown>): AgentSession => {
    const id = str(params, "session");
    if (id === undefined || id === conn.session.info.session) return conn.session;
    if (!SESSION_ID.test(id)) throw new Error("That is not a valid session id.");
    const found = manager.get(conn.client.name, id);
    if (!found) throw new Error(`No session "${id}" for ${conn.client.name}.`);
    return found;
  };

  const methods: Record<string, Handler> = {
    status: async (conn) => ({
      version: VERSION,
      pid: process.pid,
      socket: opts.paths.socket,
      browser: browser !== null,
      client: conn.client.name,
      mode: conn.policy().mode,
      session: conn.session.info.session,
      label: conn.session.label,
      sessions: manager.list(),
    }),
    tools: async () => TOOL_SPECS.filter((t) => t.name !== "done").map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
    call: async (conn, params) => {
      const name = str(params, "name");
      const args = params.args ?? {};
      if (!name) throw new Error("call needs a tool name.");
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("args must be an object.");
      return manager.call(conn.session, { id: `${Date.now()}`, name, args: args as Record<string, unknown> }, conn.policy());
    },
    tabs: async (conn) => manager.tabs(conn.session),
    sessions: async () => manager.list(),
    focus: async (conn, params) => ({ tab: await manager.focus(sessionOf(conn, params)) }),
    end: async (conn, params) => {
      const how = str(params, "onEnd") as OnEnd | undefined;
      if (how !== undefined && how !== "close" && how !== "sleep") throw new Error('onEnd must be "close" or "sleep".');
      await manager.end(sessionOf(conn, params), how);
      return { ended: true };
    },
    "clients.list": async (conn) => (adminOnly(conn), registry.list()),
    "clients.revoke": async (conn, params) => {
      adminOnly(conn);
      await registry.revoke(str(params, "name") ?? "");
      return registry.list();
    },
    "clients.allow": async (conn, params) => (adminOnly(conn), registry.allow(str(params, "name") ?? ""), registry.list()),
    "clients.mode": async (conn, params) => {
      adminOnly(conn);
      const mode = params.mode;
      if (!isMode(mode)) throw new Error("The mode must be ask, guard or skip.");
      registry.setMode(str(params, "name") ?? "", mode);
      return registry.list();
    },
  };

  const server = await startServer({
    socket: opts.paths.socket,
    registry,
    manager,
    audit,
    methods,
    graceMs: opts.graceMs,
    helloTimeoutMs: opts.helloTimeoutMs,
    approvalTimeoutMs: opts.approvalTimeoutMs,
  });

  return {
    manager,
    registry,
    async stop() {
      server.stop();
      await manager.closeAll();
      const b = browser;
      browser = null;
      if (b) await (await b.catch(() => null))?.close();
    },
  };
}

/** The browser perchd drives: a given one, Perch itself when installed, else Chrome for Testing. */
export function browserExecutable(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const perch = `${PERCH_APP}/Contents/MacOS/Perch`;
  return existsSync(perch) ? perch : undefined;
}
