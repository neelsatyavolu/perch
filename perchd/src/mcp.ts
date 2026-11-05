/**
 * Perch's MCP server over stdio: the browser tools for outside agents (Claude Code, Codex, Grok).
 *
 *   bun run src/mcp.ts [--profile <dir>] [--audit <file>] [--mode ask|guard|skip] [--show]
 *
 * Every call goes through the same rules as a sidebar chat (src/agent/session.ts). There is no
 * approval UI here yet, so anything that needs approval is declined and the client is told so.
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./agent/audit";
import type { Mode } from "./agent/permissions";
import { callTool, type CallPolicy } from "./agent/session";
import { newToolContext, TOOL_SPECS, type ToolContext } from "./agent/tools";
import { Browser } from "./browser/browser";

const PROTOCOL = "2025-06-18";
const SERVER = { name: "perch", version: "0.1.0" };

type Request = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any };

export type ServerOptions = { profileDir: string; policy: CallPolicy; headless: boolean; userAgent?: string };

export function createServer(opts: ServerOptions) {
  let ctx: Promise<ToolContext> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const context = () =>
    (ctx ??= Browser.launch({
      userDataDir: opts.profileDir,
      headless: opts.headless,
      args: opts.userAgent ? [`--user-agent=${opts.userAgent}`] : [],
    }).then((browser) => newToolContext(browser)));

  async function handle(req: Request): Promise<object | null> {
    switch (req.method) {
      case "initialize":
        return { protocolVersion: req.params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: TOOL_SPECS.filter((t) => t.name !== "done").map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
        };
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        // One call at a time: each result is checked by the client before the next action.
        const run = queue.then(async () => callTool(await context(), opts.policy, { id: String(req.id), name, args }));
        queue = run.catch(() => undefined);
        const result = await run;
        const content: object[] = [{ type: "text", text: result.content }];
        if (result.image) content.push({ type: "image", data: result.image, mimeType: "image/jpeg" });
        return { content, isError: Boolean(result.isError) };
      }
      default:
        throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
    }
  }

  return {
    async message(req: Request): Promise<object | null> {
      if (req.id === undefined) return null;
      try {
        return { jsonrpc: "2.0", id: req.id, result: await handle(req) };
      } catch (error) {
        const e = error as Error & { code?: number };
        return { jsonrpc: "2.0", id: req.id, error: { code: e.code ?? -32603, message: e.message } };
      }
    },
    async close(): Promise<void> {
      if (ctx) {
        const c = await ctx;
        await c.close();
        await c.browser.close();
      }
    },
  };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const audit = new AuditLog(arg(argv, "--audit") ?? join(homedir(), "Library", "Application Support", "Perch", "mcp-audit.jsonl"));
  const server = createServer({
    profileDir: arg(argv, "--profile") ?? mkdtempSync(join(tmpdir(), "perch-mcp-")),
    headless: !argv.includes("--show"),
    userAgent: arg(argv, "--user-agent"),
    policy: {
      mode: (arg(argv, "--mode") ?? "guard") as Mode,
      audit,
      client: arg(argv, "--client") ?? "mcp",
      approve: async () => false,
    },
  });
  const stop = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: Request;
      try {
        req = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        continue;
      }
      // Requests are answered as they finish; tool calls themselves run one at a time.
      void server.message(req).then((reply) => {
        if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
      });
    }
  }
  await server.close();
}

if (import.meta.main) await main(process.argv.slice(2));
