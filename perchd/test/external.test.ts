import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, claudeLineToEvents, codexArgs, codexLineToEvents, otherCodexServers, runClaudeCode, runCodex, subscriptionEnv } from "../src/external";

test("Claude Code stream lines become Aside-style events", () => {
  const toolUse = { type: "assistant", message: { content: [{ type: "text", text: "Opening the site." }, { type: "tool_use", id: "t1", name: "mcp__perch__navigate", input: { url: "https://example.com" } }] } };
  expect(claudeLineToEvents(toolUse)).toEqual([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Opening the site." }] } },
    { type: "tool_execution_start", toolName: "navigate", args: { url: "https://example.com" } },
  ]);
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Page: Example" }, { type: "image", source: {} }] }] } };
  expect(claudeLineToEvents(toolResult)).toEqual([{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "Page: Example" }] } }]);
  expect(claudeLineToEvents({ type: "result", subtype: "success", result: "The answer is 42." })).toEqual([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The answer is 42." }] } },
  ]);
  expect(claudeLineToEvents({ type: "system", subtype: "init" })).toEqual([]);
});

test("the Claude Code command only allows Perch's browser tools and web search, and keeps no session", () => {
  const args = claudeArgs({ model: "sonnet", mcpConfig: "/tmp/mcp.json", systemPrompt: "SYS" });
  // The task goes in on stdin, never in the arguments.
  expect(args.slice(0, 2)).toEqual(["-p", "--no-session-persistence"]);
  expect(args).toContain("--strict-mcp-config");
  expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__perch__*,WebSearch");
  const disallowed = args[args.indexOf("--disallowedTools") + 1]!;
  for (const tool of ["Bash", "Read", "Write", "Task", "WebFetch"]) expect(disallowed).toContain(tool);
  expect(disallowed).not.toContain("WebSearch");
  expect(args).not.toContain("--effort");
  expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(args[args.indexOf("--system-prompt") + 1]).toBe("SYS");
});


test("Codex JSON items become Aside-style events (shapes recorded from codex-cli 0.166)", () => {
  const call = { type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "perch", tool: "navigate", arguments: { url: "https://x.org" }, result: { content: [{ type: "text", text: "Page: X" }] }, status: "completed" } };
  expect(codexLineToEvents(call)).toEqual([
    { type: "tool_execution_start", toolName: "navigate", args: { url: "https://x.org" } },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "Page: X" }] } },
  ]);
  expect(codexLineToEvents({ type: "item.completed", item: { type: "agent_message", text: "Done." } })).toEqual([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }]);
  expect(codexLineToEvents({ type: "turn.completed" })).toEqual([]);
  // With a started set, the step is reported when the call starts and only its result when it ends.
  const started = new Set<string>();
  expect(codexLineToEvents({ type: "item.started", item: { id: "item_2", type: "mcp_tool_call", server: "perch", tool: "navigate", arguments: { url: "https://x.org" } } }, started)).toEqual([
    { type: "tool_execution_start", toolName: "navigate", args: { url: "https://x.org" } },
  ]);
  expect(codexLineToEvents(call, started)).toEqual([{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "Page: X" }] } }]);
  expect(codexLineToEvents({ type: "item.started", item: { id: "item_2", type: "mcp_tool_call", tool: "navigate" } })).toEqual([]);
});

test("the Codex command sets the model and, when given, the reasoning effort", () => {
  const base = { mcpArgs: ["run", "mcp.ts"], otherServers: [] as string[] };
  const low = codexArgs({ ...base, model: "gpt-6.1-sol", effort: "low" });
  expect(low[low.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
  expect(low).toContain('model_reasoning_effort="low"');
  expect(low[low.indexOf('model_reasoning_effort="low"') - 1]).toBe("-c");
  // The prompt goes in on stdin; the session is not kept on disk.
  expect(low).toContain("--ephemeral");
  expect(low.at(-1)).toBe('model_reasoning_effort="low"');
  const plain = codexArgs(base);
  expect(plain.some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
  expect(plain).not.toContain("-m");
  expect(() => codexArgs({ ...base, effort: 'low" x' })).toThrow();
});

test("other Codex MCP servers are found so they can be switched off", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-cfg-"));
  writeFileSync(join(dir, "config.toml"), '[mcp_servers.parallel]\ncommand = "x"\n[mcp_servers.parallel.env]\nA = "1"\n[mcp_servers.firecrawl]\n[mcp_servers.perch]\n');
  expect(otherCodexServers(join(dir, "config.toml"))).toEqual(["parallel", "firecrawl"]);
});
test("the Claude Code command passes the chat's reasoning effort and refuses unknown ones", () => {
  const args = claudeArgs({ model: "sonnet", mcpConfig: "/tmp/mcp.json", systemPrompt: "SYS", effort: "medium" });
  expect(args[args.indexOf("--effort") + 1]).toBe("medium");
  expect(() => claudeArgs({ model: "sonnet", mcpConfig: "/tmp/mcp.json", systemPrompt: "SYS", effort: "max; rm" })).toThrow(/unknown reasoning effort/);
});

/** A stand-in CLI that records its arguments, environment and stdin, then prints `reply`. */
function fakeCli(dir: string, reply: string): string {
  const bin = join(dir, "cli");
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\nenv > "${dir}/env"\ncat > "${dir}/stdin"\necho '${reply}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("Claude Code and Codex get the task on stdin and the session token in the environment, never in their arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-fake-cli-"));
  const mcp = { command: "/x/perch", args: ["mcp"], env: { PERCH_TOKEN: "tok-secret" } };
  const task = "Find the dentist's phone number for my-private-task";
  try {
    process.env.PERCH_CLAUDE_BIN = fakeCli(dir, JSON.stringify({ type: "result", result: "Done" }));
    expect((await runClaudeCode({ task, timeoutMs: 10_000, auditPath: join(dir, "audit"), mcp })).answer).toBe("Done");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(task);
    expect(readFileSync(join(dir, "args"), "utf8")).not.toContain("my-private-task");

    process.env.PERCH_CODEX_BIN = fakeCli(dir, JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } }));
    expect((await runCodex({ task, timeoutMs: 10_000, auditPath: join(dir, "audit"), mcp })).answer).toBe("Done");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toContain(task);
    const args = readFileSync(join(dir, "args"), "utf8");
    expect(args).not.toContain("my-private-task");
    expect(args).not.toContain("tok-secret");
    expect(readFileSync(join(dir, "env"), "utf8")).toContain("PERCH_TOKEN=tok-secret");
  } finally {
    delete process.env.PERCH_CLAUDE_BIN;
    delete process.env.PERCH_CODEX_BIN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Code and Codex run on the signed-in plan: API-key variables are left out of their environment", () => {
  const env = subscriptionEnv({ HOME: "/Users/x", PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_AUTH_TOKEN: "t", OPENAI_API_KEY: "sk", CODEX_API_KEY: "c" });
  expect(env).toEqual({ HOME: "/Users/x", PATH: "/bin" });
});
