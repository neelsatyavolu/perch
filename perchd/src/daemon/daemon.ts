/**
 * perchd as a long-running process: one browser, the client socket and the agent sessions.
 * Inside Perch the browser starts it (plan 3b); until then `perch` starts it on first use.
 */

import type { SidebarExtras } from "../app/sidebar-extras";
import { PERCH_VERSION } from "../version";
import { needsApproval } from "../agent/permissions";
import { DECLINED } from "../agent/session";
import type { ToolCall } from "../models/types";
import { SIDEBAR_CLIENT } from "./server";
import { existsSync } from "node:fs";
import { AuditLog } from "../agent/audit";
import { PolicyAuditMirror } from "../agent/audit-mirror";
import { TOOL_SPECS } from "../agent/tools";
import { removeStaleWorkFolders } from "../agent/stale-folders";
import { Browser } from "../browser/browser";
import type { Mode } from "../agent/permissions";
import { ManagedError, type PolicyView } from "../policy/policy";
import { ClientRegistry, isMode, raisesMode } from "./clients";
import { macConfirm, type Confirm } from "./confirm";
import { MemoryKeychain, type Keychain } from "./keychain";
import type { PerchPaths } from "./paths";
import { SESSION_ID, type OnEnd } from "./protocol";
import type { Tasks } from "../app/tasks";
import { ReplSessions } from "../agent/repl";
import type { MemoryApi } from "../memory/api";
import type { SkillCatalog } from "../skills/catalog";
import { startServer, type Connection, type Handler, type ServerOptions, type SidebarRun } from "./server";
import { cdpTabGroups, SessionManager, type AgentSession, type TabGroups } from "./sessions";

export const VERSION = PERCH_VERSION;
export const PERCH_APP = "/Applications/Perch.app";
export const PERCH_BUNDLE_ID = "co.xanom.perch";
/** What a command that needs the app answers without it; the CLI exits 3 (Perch not running) on it. */
export const APP_NEEDED = "Tasks, memory and skills need the Perch app. Open Perch and try again.";

export type DaemonOptions = {
  paths: PerchPaths;
  keychain: Keychain;
  /** Holds the key that seals clients.json; a Keychain service of its own. */
  sealKeychain?: Keychain;
  /** Asks the person at the Mac before a client may do more (a macOS dialog by default). */
  confirm?: Confirm;
  launch: () => Promise<Browser>;
  groups?: TabGroups;
  graceMs?: number;
  helloTimeoutMs?: number;
  idleSleepMs?: number;
  approvalTimeoutMs?: number;
  /** Sessions started from Perch's sidebar (src/app/sidebar-runner.ts). */
  sidebar?: (session: string) => SidebarRun | undefined;
  /** Company policy (spec 12.2); a watcher's changes close connections it no longer allows. */
  policy?: PolicyView & { onChange?: (listener: () => void) => () => void };
  /** The audit log to write; inside Perch, the profile's one log. Defaults to the Perch folder's. */
  audit?: AuditLog;
  /** Inside Perch: the browser asks the user for clients that cannot ask themselves. */
  browser?: ServerOptions["browser"];
  /** Inside Perch: tasks, memory and skills for outside clients (`perch exec`, `perch memory`). */
  outside?: () => Outside | undefined;
};

/** What Perch's app lends the daemon for outside clients, once it has started. */
export type Outside = {
  tasks: Tasks;
  memory: () => Promise<MemoryApi | undefined>;
  skills: () => Promise<SkillCatalog>;
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

/** The tools an outside client may call: the browser tools. App tools are for Perch's own agent. */
const CLIENT_TOOLS = TOOL_SPECS.filter((t) => t.name !== "done");
const CLIENT_TOOL_NAMES = new Set(CLIENT_TOOLS.map((t) => t.name));

const MODE_TEXT: Record<Mode, string> = {
  ask: "ask before every change",
  guard: "act without asking, except sends, posts, deletes, uploads and payments",
  skip: "act without asking, except payments and password changes",
};

const DECLINED_HERE = "Not changed: it was not allowed in the Perch dialog.";

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  removeStaleWorkFolders();
  let browser: Promise<Browser> | null = null;
  const maxMode = () => opts.policy?.current().MaxPermissionMode;
  const registry = new ClientRegistry(opts.paths.clientsFile, opts.keychain, opts.sealKeychain ?? new MemoryKeychain(), maxMode);
  await registry.load();
  const confirm = opts.confirm ?? macConfirm();
  const audit = opts.audit ?? new AuditLog(opts.paths.auditFile, { legacy: opts.paths.legacyAuditFiles, ...(opts.policy ? { mirror: new PolicyAuditMirror(opts.policy) } : {}) });
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

  /** The sidebar run a connection works for, when it is a Perch sidebar agent. */
  const sidebarRunOf = (conn: Connection) => (conn.client.name === SIDEBAR_CLIENT ? opts.sidebar?.(conn.session.info.session) : undefined);

  /** A skill or memory call from a sidebar agent, under the chat's mode and approval card. */
  const extraCall = async (conn: Connection, extras: SidebarExtras, call: ToolCall) => {
    const problem = extras.check(call);
    if (problem) return { content: problem, isError: true };
    const run = sidebarRunOf(conn)!;
    const described = extras.describe(call);
    const decision = extras.mustAsk(call) ? "ask" : needsApproval(run.mode, described.kind);
    if (decision === "block") return { content: "Not allowed here.", isError: true };
    if (decision === "ask" && !(await run.approve({ call, kind: described.kind, site: described.site, summary: described.summary }))) return { content: DECLINED, isError: true };
    return extras.run(call, new AbortController().signal);
  };

  /** Tasks, memory and skills are Perch's own: there is nothing to lend without the app, and a sidebar agent may not start tasks. */
  const outsideOf = (conn: Connection): Outside => {
    if (conn.client.name === SIDEBAR_CLIENT) throw new Error("A Perch chat's agent cannot start or read tasks.");
    const outside = opts.outside?.();
    if (!outside) throw new Error(APP_NEEDED);
    return outside;
  };
  const memoryOf = async (conn: Connection): Promise<MemoryApi> => {
    const api = await outsideOf(conn).memory();
    if (!api) throw new Error("Memory is off in Perch's settings.");
    return api;
  };

  const repls = new ReplSessions();

  const methods: Record<string, Handler> = {
    // `perch repl`: a persistent JavaScript session over this client's tabs (src/agent/repl.ts).
    "repl.run": async (conn, params) => {
      const code = str(params, "code");
      if (code === undefined) throw new Error("code is required.");
      return repls.run(conn.session.key, code, (call) => manager.call(conn.session, call, conn.policy()));
    },
    "repl.reset": async (conn) => ({ reset: repls.reset(conn.session.key) }),
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
    tools: async (conn) => [...CLIENT_TOOLS, ...(sidebarRunOf(conn)?.extras?.specs() ?? [])].map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
    call: async (conn, params) => {
      const name = str(params, "name");
      const args = params.args ?? {};
      if (!name) throw new Error("call needs a tool name.");
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("args must be an object.");
      const extras = sidebarRunOf(conn)?.extras;
      if (extras?.handles(name)) return extraCall(conn, extras, { id: `${Date.now()}`, name, args: args as Record<string, unknown> });
      if (!CLIENT_TOOL_NAMES.has(name)) return { content: `Perch has no tool "${name}" for outside agents.`, isError: true };
      const call = { id: `${Date.now()}`, name, args: args as Record<string, unknown> };
      // An outside agent's steps show in its chat, so clicking one of its agent tabs shows its work.
      if (conn.client.name !== SIDEBAR_CLIENT && !sidebarRunOf(conn)) opts.browser?.()?.step?.(conn.session, call);
      return manager.call(conn.session, call, conn.policy());
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
    "task.start": async (conn, params) =>
      outsideOf(conn).tasks.start({ client: conn.client.name, clientMode: conn.policy().mode, task: need(params, "task"), model: str(params, "model"), effort: str(params, "effort"), mode: str(params, "mode") }),
    "task.list": async (conn) => outsideOf(conn).tasks.list(conn.client.name),
    "task.get": async (conn, params) => outsideOf(conn).tasks.get(conn.client.name, need(params, "id")),
    "task.send": async (conn, params) => outsideOf(conn).tasks.send(conn.client.name, need(params, "id"), need(params, "text")),
    "task.steer": async (conn, params) => outsideOf(conn).tasks.steer(conn.client.name, need(params, "id"), need(params, "text")),
    "task.queue": async (conn, params) => outsideOf(conn).tasks.queue(conn.client.name, need(params, "id"), need(params, "text")),
    "task.stop": async (conn, params) => outsideOf(conn).tasks.stop(conn.client.name, need(params, "id")),
    "task.delete": async (conn, params) => outsideOf(conn).tasks.remove(conn.client.name, need(params, "id")),
    "task.models": async (conn) => outsideOf(conn).tasks.models(),
    "memory.search": async (conn, params) => {
      const api = await memoryOf(conn);
      const limit = typeof params.limit === "number" ? params.limit : 10;
      const hits = unwrap(await api.search({ query: need(params, "query"), limit }));
      await audit.append({ time: new Date().toISOString(), tab: "", site: "memory", action: "memory_search", detail: `search (${need(params, "query").length} characters)`, client: conn.client.name, approved: null, result: "ok" });
      return hits;
    },
    "memory.list": async (conn) => unwrap(await (await memoryOf(conn)).listPages({})),
    "memory.show": async (conn, params) => {
      const api = await memoryOf(conn);
      const wanted = need(params, "path");
      const page = unwrap(await api.listPages({})).find((p) => p.path === wanted || p.id === wanted || p.path === `${wanted}.md`);
      if (!page) throw new Error(`No memory page "${wanted}". List them with: perch memory list`);
      await audit.append({ time: new Date().toISOString(), tab: "", site: "memory", action: "memory_show", detail: page.path, client: conn.client.name, approved: null, result: "ok" });
      return unwrap(await api.getPage({ id: page.id }));
    },
    "skills.list": async (conn) => (await outsideOf(conn).skills()).list().map((s) => ({ name: s.name, description: s.description, origin: s.origin })),
    "skills.show": async (conn, params) => {
      const text = (await outsideOf(conn).skills()).read(need(params, "name"), str(params, "file") ?? "SKILL.md");
      if (text === null) throw new Error(`No skill "${need(params, "name")}". List them with: perch skills list`);
      return text;
    },
    "clients.list": async (conn) => (adminOnly(conn), registry.list()),
    // Revoking and lowering a mode take effect at once; letting a client do more needs the person.
    "clients.revoke": async (conn, params) => {
      adminOnly(conn);
      const name = str(params, "name") ?? "";
      if (name === "cli") throw new Error("The perch command cannot revoke itself.");
      await registry.revoke(name);
      server.disconnect(name);
      await manager.endClient(name);
      return registry.list();
    },
    "clients.allow": async (conn, params) => {
      adminOnly(conn);
      const name = str(params, "name") ?? "";
      if (registry.find(name).revoked && !(await confirm(`Let "${name}" use Perch again?`))) throw new Error(DECLINED_HERE);
      await registry.allow(name);
      return registry.list();
    },
    "clients.mode": async (conn, params) => {
      adminOnly(conn);
      const mode = params.mode;
      if (!isMode(mode)) throw new Error("The mode must be ask, guard or skip.");
      const name = str(params, "name") ?? "";
      const max = maxMode();
      if (max && raisesMode(max, mode)) throw new ManagedError(`Your organization allows outside agents up to ${max} mode.`);
      if (raisesMode(registry.find(name).mode, mode) && !(await confirm(`Let "${name}" ${MODE_TEXT[mode]} in Perch (${mode} mode)?`))) throw new Error(DECLINED_HERE);
      await registry.setMode(name, mode);
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
    sidebar: opts.sidebar,
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.browser ? { browser: opts.browser } : {}),
  });
  const stopWatching = opts.policy?.onChange?.(() => server.enforce());

  return {
    manager,
    registry,
    async stop() {
      stopWatching?.();
      repls.close();
      server.stop();
      await manager.closeAll();
      const b = browser;
      browser = null;
      if (b) await (await b.catch(() => null))?.close();
    },
  };
}

/**
 * The browser perchd drives: a given one; else the Perch app this perchd is inside (a copy
 * elsewhere, such as a test build, drives itself, not the installed app); else the installed
 * Perch; else Chrome for Testing.
 */
export function browserExecutable(explicit?: string, execPath: string = process.execPath, exists: (path: string) => boolean = existsSync): string | undefined {
  if (explicit) return explicit;
  const own = /^(.*?\.app)\/Contents\/Frameworks\//.exec(execPath)?.[1];
  for (const app of [own, PERCH_APP]) {
    const perch = app && `${app}/Contents/MacOS/Perch`;
    if (perch && exists(perch)) return perch;
  }
  return undefined;
}

function need(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value;
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
