import { expect, test } from "bun:test";
import { claudeArgs, claudeLineToEvents } from "../src/external";

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
