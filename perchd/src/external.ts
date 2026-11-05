/**
 * Runs a task through an outside agent that drives Perch over MCP: Claude Code headless, which is
 * how Claude subscribers use Perch (spec 7.3). Used by `perch exec` and the benchmark runner.
 * Output events use the Aside CLI's log format, so Aside's published runners work unchanged.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { systemPrompt } from "./agent/prompt";

export type AsideEvent =
  | { type: "tool_execution_start"; toolName: string; args: unknown }
  | { type: "message_end"; message: { role: "assistant" | "toolResult"; content: { type: "text"; text: string }[] } };

export type ExternalResult = { answer: string; events: AsideEvent[]; exitCode: number | null; timedOut: boolean; stderr: string };

const TOOL_RESULT_LIMIT = 6000;
const BLOCKED_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "Read", "Glob", "Grep", "LS", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "Skill", "SlashCommand", "ExitPlanMode",
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

export function claudeArgs(opts: { model: string; mcpConfig: string; systemPrompt: string; task: string }): string[] {
  return [
    "-p", opts.task,
    "--model", opts.model,
    "--output-format", "stream-json",
    "--verbose",
    "--mcp-config", opts.mcpConfig,
    "--strict-mcp-config",
    "--system-prompt", opts.systemPrompt,
    // The user's own hooks (stop hooks, audits) are for their coding sessions, not browser tasks.
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--allowedTools", "mcp__perch__*",
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

export async function runClaudeCode(opts: {
  task: string;
  model: string;
  timeoutMs: number;
  auditPath: string;
  userAgent?: string;
  onEvent?: (event: AsideEvent) => void;
}): Promise<ExternalResult> {
  // A scratch folder outside the home folder, so no project instructions are picked up.
  const work = mkdtempSync(join(tmpdir(), "perch-exec-"));
  const mcpConfig = join(work, "mcp.json");
  const mcpArgs = ["run", MCP_ENTRY, "--mode", "guard", "--client", "claude-code", "--audit", opts.auditPath, "--profile", join(work, "profile")];
  if (opts.userAgent) mcpArgs.push("--user-agent", opts.userAgent);
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { perch: { command: process.execPath, args: mcpArgs } } }));
  const prompt = `${systemPrompt({ mode: "guard", now: new Date() })}\n\nYour tools are Perch's browser tools (mcp__perch__*). Do the task in the browser. When you finish, reply with the answer or the result in your final message, including the specific facts the task asks for.`;
  const child = Bun.spawn([claudeBinary(), ...claudeArgs({ model: opts.model, mcpConfig, systemPrompt: prompt, task: opts.task })], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "perch-exec" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, opts.timeoutMs);
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
  clearTimeout(timer);
  const stderr = await new Response(child.stderr).text();
  rmSync(work, { recursive: true, force: true });
  return { answer, events, exitCode, timedOut, stderr };
}
