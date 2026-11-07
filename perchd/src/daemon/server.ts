/**
 * perchd's local endpoint for the CLI and MCP clients (spec 7.1): a Unix socket, 0600, in a
 * 0700 folder. Every connection says who it is with a client token from the Keychain, then
 * works in its own session under that client's permission mode.
 */

import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import type { Socket, UnixSocketListener } from "bun";
import type { ApprovalRequest, CallPolicy } from "../agent/session";
import type { AuditLog } from "../agent/audit";
import type { Mode } from "../agent/permissions";
import type { ClientRecord, ClientRegistry } from "./clients";
import { parseClientMessage, parseHello, type ApproveAsk, type Hello, type Request } from "./protocol";
import type { AgentSession, SessionManager } from "./sessions";
import { LineReader, SocketWriter } from "./wire";

export type Handler = (conn: Connection, params: Record<string, unknown>) => Promise<unknown>;

/** The client name a Perch sidebar run's outside agent connects as. */
export const SIDEBAR_CLIENT = "perch-sidebar";

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
};

/** One client connection after hello. */
export class Connection {
  private nextAsk = 1;
  private readonly asks = new Map<number, (approved: boolean) => void>();

  constructor(
    readonly hello: Hello,
    readonly client: ClientRecord,
    readonly session: AgentSession,
    private readonly writer: SocketWriter,
    private readonly opts: ServerOptions,
  ) {}

  /** The client's rules: its registered mode, its approvals, its name in the audit log. */
  policy(): CallPolicy {
    const run = this.hello.client === SIDEBAR_CLIENT ? this.opts.sidebar?.(this.hello.session) : undefined;
    if (run) return { mode: run.mode, audit: this.opts.audit, client: this.session.key, approve: run.approve };
    return {
      mode: this.opts.registry.list().find((c) => c.name === this.client.name)?.mode ?? this.client.mode,
      audit: this.opts.audit,
      client: this.session.key,
      approve: (request) => this.approve(request),
    };
  }

  private approve(request: ApprovalRequest): Promise<boolean> {
    if (!this.hello.interactive) return Promise.resolve(false);
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
    for (const id of [...this.asks.keys()]) this.answer(id, false);
  }
}

type State = { reader: LineReader; writer: SocketWriter; conn: Connection | null; helloing: boolean; closed: boolean; timer: ReturnType<typeof setTimeout> };

export type Server = {
  stop(): void;
  /** Closes every open connection of a client, as after a revoke. */
  disconnect(client: string): void;
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

  async function onHello(state: State, value: unknown): Promise<void> {
    const hello = parseHello(value);
    if (typeof hello === "string") return fail(state, hello);
    const run = hello.client === SIDEBAR_CLIENT ? opts.sidebar?.(hello.session) : undefined;
    const verified: Awaited<ReturnType<ClientRegistry["verify"]>> =
      hello.client === SIDEBAR_CLIENT
        ? run && sameToken(hello.token, run.token)
          ? { name: SIDEBAR_CLIENT, mode: run.mode, created: new Date().toISOString() }
          : { error: "Perch did not accept this client's token." }
        : await opts.registry.verify(hello.client, hello.token);
    if ("error" in verified) {
      await opts.audit.append({ time: new Date().toISOString(), tab: "", site: "", action: "connect", client: hello.client, approved: null, result: "blocked" });
      return fail(state, verified.error);
    }
    // The client left while its token was being checked: open nothing it would never release.
    if (state.closed) return;
    const session = opts.manager.open({ client: hello.client, session: hello.session, agent: hello.agent, title: hello.title, persistent: hello.persistent, onEnd: hello.onEnd });
    session.connections++;
    // A sidebar task on the tab the user is looking at works in that tab, not a copy of it. If the
    // tab is gone or another agent has it, the task still runs and opens its own tabs.
    if (run?.tab && !session.borrowed.has(run.tab)) await opts.manager.borrow(session, run.tab).catch(() => undefined);
    state.conn = new Connection(hello, verified, session, state.writer, opts);
    clearTimeout(state.timer);
    state.writer.send({ type: "welcome", client: hello.client, session: hello.session, label: session.label, mode: state.conn.policy().mode });
  }

  async function onRequest(state: State, req: Request): Promise<void> {
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
        const state: State = { reader: new LineReader(), writer, conn: null, helloing: false, closed: false, timer: setTimeout(() => fail(state, "No hello in time."), opts.helloTimeoutMs ?? 5000) };
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
        const rest = new Set(live);
        rest.delete(state);
        live = rest;
        clearTimeout(state.timer);
        const conn = state.conn;
        if (!conn) return;
        conn.declineAll();
        conn.session.connections--;
        if (conn.session.connections > 0) return;
        if (conn.hello.persistent) opts.manager.scheduleEnd(conn.session, opts.graceMs ?? 10_000);
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
    disconnect(client) {
      for (const state of live) if (state.conn?.client.name === client) fail(state, `Client "${client}" was revoked.`);
    },
  };
}
