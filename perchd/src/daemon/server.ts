/**
 * perchd's local endpoint for the CLI and MCP clients (spec 7.1): a Unix socket, 0600, in a
 * 0700 folder. Every connection says who it is with a client token from the Keychain, then
 * works in its own session under that client's permission mode.
 */

import type { SidebarExtras } from "../app/sidebar-extras";
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import type { Socket, UnixSocketListener } from "bun";
import type { ApprovalRequest, CallPolicy } from "../agent/session";
import type { AuditLog } from "../agent/audit";
import { PRIVATE_AUDIT } from "../agent/audit-seal";
import type { Mode } from "../agent/permissions";
import { AGENT_OFF, agentAllowed, allowsClient, capMode, CLIENTS_OFF, siteRuleFor, type PolicyView } from "../policy/policy";
import type { ClientRecord, ClientRegistry } from "./clients";
import { parseClientMessage, parseHello, type ApproveAsk, type Hello, type Request } from "./protocol";
import type { AgentSession, SessionManager } from "./sessions";
import { LineReader, SocketWriter } from "./wire";
import type { ToolCall } from "../models/types";

export type Handler = (conn: Connection, params: Record<string, unknown>) => Promise<unknown>;

/** The client name a Perch sidebar run's outside agent connects as. */
export const SIDEBAR_CLIENT = "perch-sidebar";
/** A chat's agent session (sidebar-runner.ts): its tabs stay between turns. */
export const CHAT_SESSION_PREFIX = "chat-";
/** How long a chat's tabs stay open after a turn, for the user to look at and for a follow-up to reuse. */
export const CHAT_KEEP_MS = 30 * 60_000;

/**
 * A task the user started in Perch's sidebar and handed to an outside agent (Codex, Claude Code).
 * Its session gets a one-off token, the chat's permission mode, and the sidebar's approval card.
 */
export type SidebarRun = {
  token: string;
  mode: Mode;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  /** The CDP target id of the user's tab the task starts in ("current tab" scope), if any. */
  tab?: string;
  /** The sidebar chat the run belongs to, for the browser's perch dot on the tabs it works in. */
  chatId?: string;
  /** A private chat's run (spec 5.8): its actions are not written to the audit log. */
  private?: boolean;
  /** Skills and memory for this run (app/sidebar-extras.ts), offered beside the browser tools. */
  extras?: SidebarExtras;
};

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type ServerOptions = {
  socket: string;
  registry: ClientRegistry;
  manager: SessionManager;
  audit: AuditLog;
  methods: Record<string, Handler>;
  helloTimeoutMs?: number;
  /** How long a persistent session waits for its client to reconnect before it ends. */
  graceMs?: number;
  approvalTimeoutMs?: number;
  /** The sidebar run a session id belongs to, if any. */
  sidebar?: (session: string) => SidebarRun | undefined;
  /** Company policy (spec 12.2): which clients may connect, the mode cap and site rules. */
  policy?: PolicyView;
  /** Inside Perch: approvals and first connections go to a card in the browser (src/app/outside-approvals.ts). */
  browser?: () => BrowserApprovals | undefined;
};

/** How the browser asks the user for outside clients that cannot ask themselves. */
export type BrowserApprovals = {
  approve(session: AgentSession, request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
  allowClient(name: string, signal: AbortSignal): Promise<boolean>;
  /** A tool call an outside session made, for its chat's list of steps. */
  step?(session: AgentSession, call: ToolCall): void;
};

/** Why a connection may not go on under the current policy, or null when it may. */
function refusal(client: string, policy: PolicyView | undefined): string | null {
  if (!policy) return null;
  const p = policy.current();
  if (client === SIDEBAR_CLIENT) return agentAllowed(p) ? null : AGENT_OFF;
  return allowsClient(client, p) ? null : CLIENTS_OFF;
}

/** One client connection after hello. */
export class Connection {
  private nextAsk = 1;
  private readonly asks = new Map<number, (approved: boolean) => void>();
  /** Aborted when the connection closes, which declines a card still waiting in the browser. */
  private readonly gone = new AbortController();

  constructor(
    readonly hello: Hello,
    readonly client: ClientRecord,
    readonly session: AgentSession,
    private readonly writer: SocketWriter,
    private readonly opts: ServerOptions,
  ) {}

  /** The client's rules: its registered mode, its approvals, its name in the audit log. */
  policy(): CallPolicy {
    const own = this.ownPolicy();
    const company = this.opts.policy?.current();
    if (!company) return own;
    return { ...own, mode: capMode(own.mode, company), siteRule: (host) => siteRuleFor(host, own.siteRule?.(host), company) };
  }

  private ownPolicy(): CallPolicy {
    const run = this.hello.client === SIDEBAR_CLIENT ? this.opts.sidebar?.(this.hello.session) : undefined;
    if (run) return { mode: run.mode, audit: run.private ? PRIVATE_AUDIT : this.opts.audit, client: this.session.key, approve: run.approve };
    return {
      mode: this.opts.registry.list().find((c) => c.name === this.client.name)?.mode ?? this.client.mode,
      audit: this.opts.audit,
      client: this.session.key,
      approve: (request) => this.approve(request),
    };
  }

  private approve(request: ApprovalRequest): Promise<boolean> {
    if (!this.hello.interactive) {
      // A client that cannot ask (Codex has no elicitation): inside Perch the browser asks instead.
      const browser = this.opts.browser?.();
      return browser ? browser.approve(this.session, request, this.gone.signal).catch(() => false) : Promise.resolve(false);
    }
    const id = this.nextAsk++;
    const ask: ApproveAsk = { type: "approve", id, summary: request.summary, kind: request.kind, site: request.site };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(id, false), this.opts.approvalTimeoutMs ?? 120_000);
      this.asks.set(id, (approved) => {
        clearTimeout(timer);
        resolve(approved);
      });
      this.writer.send(ask);
    });
  }

  answer(id: number, approved: boolean): void {
    const resolve = this.asks.get(id);
    this.asks.delete(id);
    resolve?.(approved);
  }

  /** A closed connection declines whatever it was asked. */
  declineAll(): void {
    this.gone.abort();
    for (const id of [...this.asks.keys()]) this.answer(id, false);
  }
}

type State = { reader: LineReader; writer: SocketWriter; conn: Connection | null; helloing: boolean; closed: boolean; left: AbortController; timer: ReturnType<typeof setTimeout> };

export type Server = {
  stop(): void;
  /** Closes every open connection of a client, as after a revoke. */
  disconnect(client: string): void;
  /** Closes every connection the current policy no longer allows; perchd calls it after a change. */
  enforce(): void;
};

async function socketInUse(path: string): Promise<boolean> {
  try {
    const s = await Bun.connect({ unix: path, socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

export async function startServer(opts: ServerOptions): Promise<Server> {
  let live = new Set<State>();
  const dir = opts.socket.slice(0, opts.socket.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (existsSync(opts.socket)) {
    if (await socketInUse(opts.socket)) throw new Error("perchd is already running");
    unlinkSync(opts.socket);
  }

  const fail = (state: State, error: string) => {
    state.writer.send({ type: "error", error });
    state.writer.end();
  };

  /**
   * Inside Perch, a client's first connection waits for the user's card in the browser. The hello
   * arrived, so its timer stops; the client leaving declines the card.
   */
  function newClientCheck(state: State): ((name: string) => Promise<boolean>) | undefined {
    const browser = opts.browser?.();
    if (!browser) return undefined;
    return (name) => {
      clearTimeout(state.timer);
      state.writer.send({ type: "notice", text: `Perch is asking you to allow "${name}" to use it. Answer the card in the Perch window to continue.` });
      return browser.allowClient(name, state.left.signal);
    };
  }

  async function onHello(state: State, value: unknown): Promise<void> {
    const hello = parseHello(value);
    if (typeof hello === "string") return fail(state, hello);
    const refused = refusal(hello.client, opts.policy);
    if (refused) {
      await opts.audit.append({ time: new Date().toISOString(), tab: "", site: "", action: "connect", client: hello.client, approved: null, result: "blocked" });
      return fail(state, refused);
    }
    const run = hello.client === SIDEBAR_CLIENT ? opts.sidebar?.(hello.session) : undefined;
    const verified: Awaited<ReturnType<ClientRegistry["verify"]>> =
      hello.client === SIDEBAR_CLIENT
        ? run && sameToken(hello.token, run.token)
          ? { name: SIDEBAR_CLIENT, mode: run.mode, created: new Date().toISOString() }
          : { error: "Perch did not accept this client's token." }
        : await opts.registry.verify(hello.client, hello.token, newClientCheck(state));
    if ("error" in verified) {
      await opts.audit.append({ time: new Date().toISOString(), tab: "", site: "", action: "connect", client: hello.client, approved: null, result: "blocked" });
      return fail(state, verified.error);
    }
    // The client left while its token was being checked: open nothing it would never release.
    if (state.closed) return;
    const session = opts.manager.open({ client: hello.client, session: hello.session, agent: hello.agent, title: hello.title, persistent: hello.persistent, onEnd: hello.onEnd });
    // A sidebar task on the tab the user is looking at works in that tab, not a copy of it. If the
    // tab is gone or another agent has it, the task still runs and opens its own tabs.
    if (run?.tab && !session.borrowed.has(run.tab)) {
      await opts.manager.borrow(session, run.tab).catch(() => undefined);
      // The client left while the tab was borrowed: give it back unless another connection uses it.
      if (state.closed) {
        if (session.connections === 0) await opts.manager.end(session, "close");
        return;
      }
    }
    session.connections++;
    state.conn = new Connection(hello, verified, session, state.writer, opts);
    clearTimeout(state.timer);
    state.writer.send({ type: "welcome", client: hello.client, session: hello.session, label: session.label, mode: state.conn.policy().mode });
  }

  async function onRequest(state: State, req: Request): Promise<void> {
    // Checked on every request too, so a policy that changes while a client is connected applies at once.
    const refused = refusal(state.conn!.hello.client, opts.policy);
    if (refused) return state.writer.send({ type: "response", id: req.id, error: refused });
    const handler = Object.hasOwn(opts.methods, req.method) ? opts.methods[req.method] : undefined;
    if (!handler) return state.writer.send({ type: "response", id: req.id, error: `Unknown method "${req.method}".` });
    try {
      const result = await handler(state.conn!, req.params);
      state.writer.send({ type: "response", id: req.id, result: result ?? null });
    } catch (error) {
      state.writer.send({ type: "response", id: req.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function onLine(socket: Socket<State>, state: State, line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return fail(state, "Messages are one JSON object per line.");
    }
    if (!state.conn) {
      if (state.helloing) return;
      state.helloing = true;
      // A Keychain or disk error fails this hello only; it must never take perchd down.
      void onHello(state, value)
        .catch((error) => {
          clearTimeout(state.timer);
          fail(state, `Perch could not check this client: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => (state.helloing = false));
      return;
    }
    const msg = parseClientMessage(value);
    if (typeof msg === "string") return state.writer.send({ type: "error", error: msg });
    if (msg.type === "approval") return state.conn.answer(msg.id, msg.approved);
    void onRequest(state, msg);
  }

  const listener: UnixSocketListener<State> = Bun.listen<State>({
    unix: opts.socket,
    socket: {
      open(socket) {
        const writer = new SocketWriter(socket);
        const state: State = { reader: new LineReader(), writer, conn: null, helloing: false, closed: false, left: new AbortController(), timer: setTimeout(() => fail(state, "No hello in time."), opts.helloTimeoutMs ?? 5000) };
        socket.data = state;
        live = new Set(live).add(state);
      },
      data(socket, chunk) {
        const state = socket.data;
        let lines: string[];
        try {
          lines = state.reader.push(chunk);
        } catch {
          return fail(state, "Message too long.");
        }
        for (const line of lines) onLine(socket, state, line);
      },
      drain(socket) {
        socket.data.writer.flush();
      },
      close(socket) {
        const state = socket.data;
        state.closed = true;
        state.left.abort();
        const rest = new Set(live);
        rest.delete(state);
        live = rest;
        clearTimeout(state.timer);
        const conn = state.conn;
        if (!conn) return;
        conn.declineAll();
        conn.session.connections--;
        if (conn.session.connections > 0) return;
        const chat = conn.hello.client === SIDEBAR_CLIENT && conn.hello.session.startsWith(CHAT_SESSION_PREFIX);
        if (chat) void opts.manager.giveBack(conn.session);
        if (conn.hello.persistent) opts.manager.scheduleEnd(conn.session, chat ? Math.max(CHAT_KEEP_MS, opts.graceMs ?? 0) : opts.graceMs ?? 10_000);
        // A terminal command that opened nothing leaves nothing behind.
        else if (!conn.session.tabIds().length && !conn.session.asleep) void opts.manager.end(conn.session, "close");
      },
    },
  });
  chmodSync(opts.socket, 0o600);
  return {
    stop() {
      listener.stop(true);
      if (existsSync(opts.socket)) unlinkSync(opts.socket);
    },
    enforce() {
      for (const state of live) {
        const refused = state.conn ? refusal(state.conn.hello.client, opts.policy) : null;
        if (refused) fail(state, refused);
      }
    },
    disconnect(client) {
      for (const state of live) if (state.conn?.client.name === client) fail(state, `Client "${client}" was revoked.`);
    },
  };
}
