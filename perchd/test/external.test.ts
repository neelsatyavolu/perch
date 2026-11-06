import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, claudeLineToEvents, codexArgs, codexLineToEvents, otherCodexServers } from "../src/external";

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

test("the Claude Code command only allows Perch's browser tools", () => {
  const args = claudeArgs({ model: "sonnet", mcpConfig: "/tmp/mcp.json", systemPrompt: "SYS", task: "Find X" });
  expect(args.slice(0, 2)).toEqual(["-p", "Find X"]);
  expect(args).toContain("--strict-mcp-config");
  expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__perch__*");
  const disallowed = args[args.indexOf("--disallowedTools") + 1]!;
  for (const tool of ["Bash", "WebFetch", "WebSearch", "Read", "Write", "Task"]) expect(disallowed).toContain(tool);
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
});

test("the Codex command sets the model and, when given, the reasoning effort", () => {
  const base = { mcpArgs: ["run", "mcp.ts"], prompt: "Do X", otherServers: [] as string[] };
  const low = codexArgs({ ...base, model: "gpt-6.1-sol", effort: "low" });
  expect(low[low.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
  expect(low).toContain('model_reasoning_effort="low"');
  expect(low[low.indexOf('model_reasoning_effort="low"') - 1]).toBe("-c");
  expect(low.at(-1)).toBe("Do X");
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