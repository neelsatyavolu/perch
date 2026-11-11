/**
 * Runs a task through an outside agent that drives Perch over MCP: Claude Code headless, which is
 * how Claude subscribers use Perch (spec 7.3). Used by `perch exec` and the benchmark runner.
 * Output events use the Aside CLI's log format, so Aside's published runners work unchanged.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { systemPrompt } from "./agent/prompt";

export type AsideEvent =
  | { type: "tool_execution_start"; toolName: string; args: unknown }
  | { type: "message_end"; message: { role: "assistant" | "toolResult"; content: { type: "text"; text: string }[] } };

export type ExternalResult = { answer: string; events: AsideEvent[]; exitCode: number | null; timedOut: boolean; stderr: string };

/** Tool output kept in the event log; graders and people reading a run need the evidence. */
const TOOL_RESULT_LIMIT = 20_000;
const BLOCKED_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "Read", "Glob", "Grep", "LS", "NotebookEdit",
  "Task", "Agent", "TodoWrite", "Skill", "SlashCommand", "ExitPlanMode",
];

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => String(c.text)).join("\n");
}

/** One Claude Code stream-json line to zero or more Aside-format events. */
export function claudeLineToEvents(line: any): AsideEvent[] {
  if (line?.type === "assistant") {
    const events: AsideEvent[] = [];
    for (const block of line.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) events.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: block.text }] } });
      if (block.type === "tool_use") events.push({ type: "tool_execution_start", toolName: String(block.name).replace(/^mcp__perch__/, ""), args: block.input ?? {} });
    }
    return events;
  }
  if (line?.type === "user") {
    return (line.message?.content ?? [])
      .filter((b: any) => b.type === "tool_result")
      .map((b: any) => ({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: text(b.content).slice(0, TOOL_RESULT_LIMIT) }] } }));
  }
  if (line?.type === "result" && typeof line.result === "string") {
    return [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: line.result }] } }];
  }
  return [];
}

export function claudeArgs(opts: { model: string; mcpConfig: string; systemPrompt: string; task: string; effort?: string }): string[] {
  if (opts.effort !== undefined && !EFFORT.test(opts.effort)) throw new Error(`unknown reasoning effort "${opts.effort}"`);
  return [
    "-p", opts.task,
    "--model", opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--output-format", "stream-json",
    "--verbose",
    "--mcp-config", opts.mcpConfig,
    "--strict-mcp-config",
    "--system-prompt", opts.systemPrompt,
    // The user's own hooks (stop hooks, audits) are for their coding sessions, not browser tasks.
    "--settings", JSON.stringify({ disableAllHooks: true }),
    // Web search and fetch answer quick lookups without opening a tab, as in Aside.
    "--allowedTools", "mcp__perch__*,WebSearch,WebFetch",
    "--disallowedTools", BLOCKED_TOOLS.join(","),
  ];
}

/** The installed Claude Code CLI itself, not a wrapper that adds its own MCP servers. */
export function claudeBinary(): string {
  const candidates = [process.env.PERCH_CLAUDE_BIN, join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude"];
  const found = candidates.find((c): c is string => Boolean(c && existsSync(c)));
  if (!found) throw new Error("Claude Code is not installed; install it or set PERCH_CLAUDE_BIN");
  return found;
}

const MCP_ENTRY = join(import.meta.dir, "mcp.ts");

export type RunOptions = {
  task: string;
  model?: string;
  /** Reasoning effort ("low", "medium", "high"), for Codex and Claude Code alike. */
  effort?: string;
  timeoutMs: number;
  auditPath: string;
  /** Permission mode for the MCP server; delegated whole tasks use "skip" (payments still ask). */
  mode?: "ask" | "guard" | "skip";
  userAgent?: string;
  /** A browser to drive instead of Chrome for Testing, such as a Perch build, with a visible window. */
  executable?: string;
  onEvent?: (event: AsideEvent) => void;
  /**
   * The MCP server to give the agent instead of a private browser: Perch's sidebar passes
   * `perch mcp` on the browser the user is looking at, with a one-off session in its env.
   */
  mcp?: McpServer;
  /** Stops the agent when the user cancels. */
  signal?: AbortSignal;
};

export type McpServer = { command: string; args: string[]; env: Record<string, string> };

/** The MCP server for a task: the one passed in, or Perch's own server on a private browser. */
function mcpServer(opts: RunOptions, client: string, work: string): McpServer {
  if (opts.mcp) return opts.mcp;
  const mode = opts.mode ?? "guard";
  const args = ["run", MCP_ENTRY, "--mode", mode, "--client", client, "--audit", opts.auditPath, "--profile", join(work, "profile")];
  return { command: process.execPath, args: [...args, ...serverArgs(opts)], env: {} };
}

/** Ends the agent on cancel or timeout: SIGTERM, then SIGKILL if it lingers. */
function stopper(child: { kill(signal?: number | NodeJS.Signals): void }, opts: RunOptions) {
  let timedOut = false;
  const stop = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, opts.timeoutMs);
  const onAbort = () => stop();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    get timedOut() {
      return timedOut;
    },
    done() {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Time kept back from the client's limit for writing the answer after the last tool call. */
const ANSWER_MARGIN_MS = 60_000;

/** MCP server arguments shared by every outside agent: the browser, and the time budget it reports. */
export function serverArgs(opts: RunOptions): string[] {
  const budgetS = Math.floor(Math.max(opts.timeoutMs / 2, opts.timeoutMs - ANSWER_MARGIN_MS) / 1000);
  return ["--time-budget-s", String(budgetS), ...browserArgs(opts)];
}

function browserArgs(opts: RunOptions): string[] {
  if (opts.executable) return ["--executable", opts.executable, "--show", "--mock-keychain"];
  return opts.userAgent ? ["--user-agent", opts.userAgent] : [];
}

export async function runClaudeCode(opts: RunOptions): Promise<ExternalResult> {
  // A scratch folder outside the home folder, so no project instructions are picked up.
  const work = mkdtempSync(join(tmpdir(), "perch-exec-"));
  const mcpConfig = join(work, "mcp.json");
  const mode = opts.mode ?? "guard";
  const server = mcpServer(opts, "claude-code", work);
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { perch: server } }), { mode: 0o600 });
  const prompt = `${systemPrompt({ mode, now: new Date(), finish: "reply", webSearch: true })}\n\nYour tools are Perch's browser tools (mcp__perch__*), plus WebSearch and WebFetch for quick public lookups. Use the browser for the user's own sites, signed-in pages and anything you act on. When you finish, reply with the answer or the result in your final message, including the specific facts the task asks for.`;
  const child = Bun.spawn([claudeBinary(), ...claudeArgs({ model: opts.model ?? "claude-sonnet-5-5", mcpConfig, systemPrompt: prompt, task: opts.task, effort: opts.effort })], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // ENABLE_TOOL_SEARCH=false: Perch's tools are loaded up front, not found by a search turn first.
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "perch-exec", ENABLE_TOOL_SEARCH: "false" },
  });
  const stop = stopper(child, opts);
  const events: AsideEvent[] = [];
  let answer = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!raw) continue;
      let line: any;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (process.env.PERCH_DEBUG_CODEX) process.stderr.write(`${Date.now()} ${raw.slice(0, 400)}\n`);
      if (line.type === "result" && typeof line.result === "string") {
        answer = line.result;
        // The answer is in; do not wait on the CLI's own shutdown (hooks, MCP teardown).
        setTimeout(() => child.kill("SIGTERM"), 3000).unref();
      }
      for (const event of claudeLineToEvents(line)) {
        events.push(event);
        opts.onEvent?.(event);
      }
    }
  }
  const exitCode = await child.exited;
  stop.done();
  const stderr = await new Response(child.stderr).text();
  rmSync(work, { recursive: true, force: true });
  return { answer, events, exitCode, timedOut: stop.timedOut, stderr };
}

function codexArgs_(item: any): unknown {
  const args: unknown = item.arguments ?? item.args ?? {};
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args; // keep the string
  }
}

/**
 * One `codex exec --json` line to zero or more Aside-format events. With `started`, a tool call is
 * reported when Codex starts it (so a chat shows the step while it runs) and only its result when
 * it completes; without it, both come at completion.
 */
export function codexLineToEvents(line: any, started?: Set<string>): AsideEvent[] {
  if (!line?.item) return [];
  const isTool = typeof line.item.type === "string" && line.item.type.includes("mcp");
  if (line.type === "item.started" && started && isTool && typeof line.item.id === "string") {
    started.add(line.item.id);
    return [{ type: "tool_execution_start", toolName: String(line.item.tool ?? line.item.name ?? "unknown").replace(/^mcp__perch__/, ""), args: codexArgs_(line.item) }];
  }
  if (line.type !== "item.completed") return [];
  const item = line.item;
  if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
    return [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: item.text }] } }];
  }
  if (typeof item.type === "string" && item.type.includes("mcp")) {
    const name = String(item.tool ?? item.name ?? "unknown").replace(/^mcp__perch__/, "");
    const result = text(item.result?.content ?? item.result ?? item.output ?? item.error ?? "");
    const done: AsideEvent = { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: result.slice(0, TOOL_RESULT_LIMIT) }] } };
    return started?.delete(item.id) ? [done] : [{ type: "tool_execution_start", toolName: name, args: codexArgs_(item) }, done];
  }
  return [];
}

/** The installed Codex CLI itself, not a wrapper. */
export function codexBinary(): string {
  const candidates = [process.env.PERCH_CODEX_BIN, "/opt/homebrew/bin/codex", join(homedir(), ".local", "bin", "codex")];
  const found = candidates.find((c): c is string => Boolean(c && existsSync(c)));
  if (!found) throw new Error("Codex CLI is not installed; install it or set PERCH_CODEX_BIN");
  return found;
}

/** MCP servers in the user's Codex config, to switch off for a browser task. */
export function otherCodexServers(config = join(homedir(), ".codex", "config.toml")): string[] {
  if (!existsSync(config)) return [];
  const names = [...readFileSync(config, "utf8").matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((m: RegExpMatchArray) => m[1]!);
  return [...new Set(names)].filter((n) => n !== "perch");
}

/** An inline TOML table of strings, for a `-c key={...}` override. JSON strings are valid TOML basic strings. */
export function tomlTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([k, v]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new Error(`bad key "${k}"`);
    return `${k}=${JSON.stringify(v)}`;
  });
  return `{${entries.join(",")}}`;
}

/** Reasoning effort names Codex accepts; anything else is refused before it reaches a -c override. */
const EFFORT = /^[a-z]+$/;

/** The `codex exec` arguments for one task: only Perch's tools, the model, and its reasoning effort. */
export function codexArgs(opts: { mcpArgs: string[]; prompt: string; model?: string; effort?: string; otherServers: string[]; command?: string; env?: Record<string, string> }): string[] {
  if (opts.effort !== undefined && !EFFORT.test(opts.effort)) throw new Error(`unknown reasoning effort "${opts.effort}"`);
  return [
    "exec", "--json", "--skip-git-repo-check", "-s", "read-only",
    "-c", 'approval_policy="never"',
    "-c", `mcp_servers.perch.command=${JSON.stringify(opts.command ?? process.execPath)}`,
    "-c", `mcp_servers.perch.args=${JSON.stringify(opts.mcpArgs)}`,
    ...(opts.env && Object.keys(opts.env).length ? ["-c", `mcp_servers.perch.env=${tomlTable(opts.env)}`] : []),
    "-c", "mcp_servers.perch.tool_timeout_sec=120",
    // Perch applies its own approval rules to every call; Codex's prompt would only block them.
    "-c", 'mcp_servers.perch.default_tools_approval_mode="approve"',
    // Only Perch's tools and Codex's own web search: the user's other MCP servers are off for the task.
    ...opts.otherServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    "-c", 'web_search="live"',
    ...(opts.model ? ["-m", opts.model] : []),
    ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : []),
    opts.prompt,
  ];
}

/** Runs a task with Codex CLI headless (the user's own ChatGPT sign-in) and Perch's MCP tools. */
export async function runCodex(opts: RunOptions): Promise<ExternalResult> {
  const work = mkdtempSync(join(tmpdir(), "perch-exec-"));
  const mode = opts.mode ?? "guard";
  const server = mcpServer(opts, "codex", work);
  const prompt = `${systemPrompt({ mode, now: new Date(), finish: "reply", webSearch: true })}\n\nYour tools for this task are Perch's browser tools from the "perch" MCP server. Do not run shell commands or read files. Use web search for quick public lookups and the browser for the user's own sites, signed-in pages and anything you act on, then reply with the answer, including the specific facts the task asks for.\n\nTask:\n${opts.task}`;
  const args = codexArgs({ mcpArgs: server.args, command: server.command, env: server.env, prompt, model: opts.model, effort: opts.effort, otherServers: otherCodexServers() });
  const child = Bun.spawn([codexBinary(), ...args], { cwd: work, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stop = stopper(child, opts);
  const events: AsideEvent[] = [];
  let answer = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const started = new Set<string>();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      let line: any;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (process.env.PERCH_DEBUG_CODEX) process.stderr.write(`${Date.now()} ${raw.slice(0, 400)}\n`);
      for (const event of codexLineToEvents(line, started)) {
        if (event.type === "message_end" && event.message.role === "assistant") answer = event.message.content[0]?.text ?? answer;
        events.push(event);
        opts.onEvent?.(event);
      }
      if (line.type === "turn.completed") setTimeout(() => child.kill("SIGTERM"), 3000).unref();
    }
  }
  const exitCode = await child.exited;
  stop.done();
  const stderr = await new Response(child.stderr).text();
  rmSync(work, { recursive: true, force: true });
  return { answer, events, exitCode, timedOut: stop.timedOut, stderr };
}
