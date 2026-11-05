/**
 * `perch mcp`: Perch's browser tools for an agent client over stdio, served by perchd in the
 * client's own session. Approvals become MCP elicitation requests when the client supports
 * them (Claude Code shows them as a prompt); otherwise risky actions are declined.
 */

import { basename } from "node:path";
import { VERSION } from "../daemon/daemon";
import type { ApproveAsk, OnEnd } from "../daemon/protocol";
import { parseArgs, UsageError } from "./args";
import type { DaemonClient } from "./client";
import { defaultSession, openDaemon, type CliIO } from "./io";
import { CLIENT_NAME } from "../daemon/keychain";
import { SESSION_ID } from "../daemon/protocol";

const PROTOCOL = "2025-06-18";
const INSTRUCTIONS = "Perch is the user's own browser. You work in your own tab group. Read pages with snapshot and act by ref. Sends, posts, deletes, uploads and payments wait for the user's approval; do not retry a declined action. Run `perch guide` for more.";

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any; result?: any; error?: any };
export type Transport = { lines: AsyncIterable<string>; write(line: string): void };
type ToolResult = { content: string; image?: string; isError?: boolean };

/** An MCP client's name ("claude-code", "codex-mcp-client") as a Perch client name. */
export function clientFromInfo(name: unknown): string {
  const raw = typeof name === "string" ? name.toLowerCase() : "";
  if (raw.startsWith("codex")) return "codex";
  if (raw.startsWith("claude")) return "claude-code";
  const clean = raw.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return clean || "mcp";
}

export type ProxyOptions = { client?: string; session: string; agent?: string; title: string; onEnd: OnEnd };

export class McpProxy {
  private daemon: Promise<DaemonClient> | null = null;
  private clientName = "";
  private elicitation = false;
  private nextAsk = 1;
  private readonly asks = new Map<string, (approved: boolean) => void>();

  constructor(private readonly io: CliIO, private readonly opts: ProxyOptions, private readonly write: (msg: Rpc) => void) {}

  /** Handles one message from the client; returns the reply, or null for notifications. */
  async message(msg: Rpc): Promise<Rpc | null> {
    if (msg.method === undefined) {
      if (msg.id !== undefined && msg.id !== null) this.asks.get(String(msg.id))?.(msg.result?.action === "accept");
      return null;
    }
    if (msg.id === undefined || msg.id === null) return null;
    try {
      return { jsonrpc: "2.0", id: msg.id, result: await this.handle(msg) };
    } catch (error) {
      const e = error as Error & { code?: number };
      return { jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } };
    }
  }

  private async handle(msg: Rpc): Promise<object> {
    switch (msg.method) {
      case "initialize":
        this.clientName = msg.params?.clientInfo?.name ?? "";
        this.elicitation = Boolean(msg.params?.capabilities?.elicitation);
        return { protocolVersion: msg.params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "perch", version: VERSION }, instructions: INSTRUCTIONS };
      case "ping":
        return {};
      case "tools/list":
        return { tools: await this.request("tools") };
      case "tools/call": {
        let result: ToolResult;
        const call = { name: String(msg.params?.name ?? ""), args: msg.params?.arguments ?? {} };
        try {
          result = await this.request<ToolResult>("call", call);
        } catch (error) {
          result = { content: `Perch is not available: ${(error as Error).message}`, isError: true };
        }
        const content: object[] = [{ type: "text", text: result.content }];
        if (result.image) content.push({ type: "image", data: result.image, mimeType: "image/jpeg" });
        return { content, isError: Boolean(result.isError) };
      }
      default:
        throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
    }
  }

  /** One request; if perchd restarted since the last one, reconnects once and tries again. */
  private async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await (await this.connect()).request<T>(method, params);
    } catch (error) {
      if ((error as Error).message !== "perchd closed the connection") throw error;
      this.daemon = null;
      return (await this.connect()).request<T>(method, params);
    }
  }

  private connect(): Promise<DaemonClient> {
    this.daemon ??= openDaemon(this.io, {
      client: this.opts.client ?? clientFromInfo(this.clientName),
      session: this.opts.session,
      agent: this.opts.agent ?? (this.clientName || undefined),
      title: this.opts.title,
      persistent: true,
      onEnd: this.opts.onEnd,
      onApprove: this.elicitation ? (ask) => this.approve(ask) : undefined,
    }).then(
      (c) => c,
      (error) => {
        this.daemon = null;
        throw error;
      },
    );
    return this.daemon;
  }

  /** Asks the user through the client (MCP elicitation), or declines when the client cannot ask. */
  approve(ask: ApproveAsk): Promise<boolean> {
    if (!this.elicitation) return Promise.resolve(false);
    const id = `perch-approve-${this.nextAsk++}`;
    return new Promise((resolve) => {
      this.asks.set(id, (approved) => {
        this.asks.delete(id);
        resolve(approved);
      });
      this.write({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message: `Perch: allow this? ${ask.summary}`, requestedSchema: { type: "object", properties: {} } } });
    });
  }

  close(): void {
    for (const resolve of this.asks.values()) resolve(false);
    void this.daemon?.then((c) => c.close()).catch(() => undefined);
  }
}

async function* stdinLines(): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
}

export async function runMcp(argv: string[], io: CliIO, transport: Transport = { lines: stdinLines(), write: (l) => void process.stdout.write(l) }): Promise<number> {
  const a = parseArgs(argv, { options: ["--client", "--session", "--agent", "--title", "--on-end"] });
  const onEnd = a.options.get("--on-end") ?? "close";
  if (onEnd !== "close" && onEnd !== "sleep") throw new UsageError("--on-end is close or sleep");
  const send = (msg: Rpc) => transport.write(`${JSON.stringify(msg)}\n`);
  // An app that launched the agent (agterm, agmux) names its session in PERCH_CLIENT and
  // PERCH_SESSION. They win over the flags of a `perch skill install` entry, so the agent's tabs
  // belong to the tab or thread it runs in.
  const envClient = io.env.PERCH_CLIENT && CLIENT_NAME.test(io.env.PERCH_CLIENT) ? io.env.PERCH_CLIENT : undefined;
  const envSession = io.env.PERCH_SESSION && SESSION_ID.test(io.env.PERCH_SESSION) ? io.env.PERCH_SESSION : undefined;
  const proxy = new McpProxy(
    // Approvals go through the client; there is no terminal on an MCP connection.
    { ...io, ask: undefined },
    {
      client: envClient ?? a.options.get("--client"),
      session: envSession ?? a.options.get("--session") ?? `mcp-${process.pid}`,
      agent: a.options.get("--agent"),
      title: a.options.get("--title") ?? basename(io.cwd),
      onEnd,
    },
    send,
  );
  for await (const raw of transport.lines) {
    const line = raw.trim();
    if (!line) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    void proxy.message(msg).then((reply) => reply && send(reply));
  }
  proxy.close();
  return 0;
}
