import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPrompt, lastClaudePrompt, lastCodexPrompt, rolloutMeta } from "../src/cli/agent-prompt";
import { cleanPrompt as tidy, MAX_PROMPT } from "../src/daemon/protocol";

const root = mkdtempSync(join(tmpdir(), "perch-agent-prompt-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const human = (text: string) => ({ type: "user", origin: { kind: "human" }, message: { role: "user", content: text } });
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } };
const assistant = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it" }] } };

function claudeHome(name: string) {
  const config = join(root, name);
  mkdirSync(join(config, "sessions"), { recursive: true });
  return config;
}

function writeClaude(config: string, cwd: string, id: string, body: string) {
  const dir = join(config, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), body);
}

test("a Claude Code transcript gives the last prompt a person typed, not tool results or notifications", () => {
  const tail = lines(
    human("first prompt"),
    assistant,
    human("open the pricing page and compare plans"),
    toolResult,
    { type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>done</task-notification>" } },
    { type: "user", isMeta: true, message: { content: [{ type: "text", text: "# Skill text" }] } },
    { type: "user", message: { content: "<command-name>/clear</command-name>" } },
    assistant,
  );
  expect(lastClaudePrompt(tail)).toBe("open the pricing page and compare plans");
});

test("pasted text and slash commands count as typed; an interrupt line does not", () => {
  expect(lastClaudePrompt(lines(human('\n\n<pasted_content id="2c2f">\nfix the login page\n</pasted_content>')))).toBe("fix the login page");
  expect(lastClaudePrompt(lines(human("<command-message>unslop</command-message>\n<command-name>/unslop</command-name>\n<command-args>all screens</command-args>")))).toBe(
    "/unslop all screens",
  );
  const interrupted = { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } };
  expect(lastClaudePrompt(lines(human("compare the plans"), assistant, interrupted))).toBe("compare the plans");
});

test("an agent's prompt is never taken from another agent whose variables it inherited", () => {
  const config = claudeHome("claude-nested");
  writeFileSync(join(config, "sessions", "5151.json"), JSON.stringify({ pid: 5151, sessionId: "outer", cwd: "/work/app" }));
  writeClaude(config, "/work/app", "outer", lines(human("the Claude Code user's prompt")));
  const home = join(root, "codex-nested");
  writeRollout(home, "2026/11/16", "t-1", lines(meta("/work/app", "t-1"), userItem("the Codex user's prompt")));
  // Claude Code started from Codex: its MCP server's parent is Claude Code, CODEX_THREAD_ID is Codex's.
  expect(agentPrompt({ env: { CLAUDE_CONFIG_DIR: config, CODEX_HOME: home, CODEX_THREAD_ID: "t-1" }, cwd: "/work/app", parent: 5151 })).toBe("the Claude Code user's prompt");
  // Codex started from Claude Code, with no rollout of its own found: nothing, not Claude Code's prompt.
  const inherited = { CLAUDE_CONFIG_DIR: config, CLAUDE_PID: "5151", CLAUDE_CODE_SESSION_ID: "outer", CODEX_HOME: join(root, "codex-none") };
  expect(agentPrompt({ env: inherited, cwd: "/work/app", parent: 0, agent: "codex" })).toBeUndefined();
  expect(agentPrompt({ env: inherited, cwd: "/work/app", parent: 0 })).toBe("the Claude Code user's prompt");
});

test("when the tail holds no prompt, Claude Code's last-prompt note stands in; a cut first line is skipped", () => {
  const tail = `{"type":"user","message":{"content":"half a li` + "\n" + lines({ type: "last-prompt", lastPrompt: "book a table for two" }, toolResult, assistant);
  expect(lastClaudePrompt(tail)).toBe("book a table for two");
  expect(lastClaudePrompt(lines(toolResult, assistant))).toBeUndefined();
});

test("the Claude Code session comes from sessions/<pid>.json, so /clear and resume are followed", () => {
  const config = claudeHome("claude-live");
  writeFileSync(join(config, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "new-session", cwd: "/work/app" }));
  writeClaude(config, "/work/app", "old-session", lines(human("old prompt")));
  writeClaude(config, "/work/app", "new-session", lines(human("the new prompt"), toolResult));
  const env = { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "old-session" };
  expect(agentPrompt({ env, cwd: "/work/app", parent: 4242 })).toBe("the new prompt");
  // A shell command has no live session file for its parent; the session id in its env is used.
  expect(agentPrompt({ env, cwd: "/work/app", parent: 999_999 })).toBe("old prompt");
});

test("a transcript in a project folder named differently is still found by its session id", () => {
  const config = claudeHome("claude-moved");
  writeClaude(config, "/elsewhere/odd name", "s-1", lines(human("from the other folder")));
  expect(agentPrompt({ env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "s-1" }, cwd: "/work/app", parent: 0 })).toBe("from the other folder");
});

test("PERCH_TASK wins, and with no HOME and no config nothing is read", () => {
  expect(agentPrompt({ env: { PERCH_TASK: "  check the invoice  " }, cwd: "/x", parent: 0 })).toBe("check the invoice");
  expect(agentPrompt({ env: {}, cwd: "/x", parent: process.pid })).toBeUndefined();
  expect(agentPrompt({ env: { CLAUDE_CONFIG_DIR: join(root, "missing"), CLAUDE_CODE_SESSION_ID: "nope" }, cwd: "/x", parent: 0 })).toBeUndefined();
});

test("prompts are tidied: control characters go, line breaks stay, and long ones are cut", () => {
  expect(tidy("a\u0007b\n\n\n\nc")).toBe("a b\n\nc");
  expect(tidy("   ")).toBeUndefined();
  const long = tidy("x".repeat(MAX_PROMPT + 50))!;
  expect(long.length).toBe(MAX_PROMPT);
  expect(long.endsWith("…")).toBe(true);
});

// Codex --------------------------------------------------------------------------------------

const meta = (cwd: string, id: string, source: unknown = "cli") => ({
  type: "session_meta",
  payload: { id, timestamp: "2026-11-16T08:00:00Z", cwd, originator: "codex_cli_rs", source, base_instructions: { text: "long" } },
});
const userItem = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

function writeRollout(home: string, day: string, id: string, body: string, ageMs = 0) {
  const dir = join(home, "sessions", ...day.split("/"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${day.replaceAll("/", "-")}T08-00-00-${id}.jsonl`);
  writeFileSync(file, body);
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(file, at, at);
}

test("a Codex rollout gives its last user_message, else the last user message that isn't injected context", () => {
  expect(lastCodexPrompt(lines(userItem("<environment_context>…"), { type: "event_msg", payload: { type: "user_message", message: "fix the signup form" } }, userItem("# AGENTS.md instructions")))).toBe(
    "fix the signup form",
  );
  expect(lastCodexPrompt(lines(userItem("summarise this PR"), userItem("<environment_context>cwd</environment_context>")))).toBe("summarise this PR");
  expect(rolloutMeta(JSON.stringify(meta("/a \"b\"", "x")).slice(0, 120))).toEqual({ cwd: '/a "b"', subagent: false });
});

test("for Codex, the newest top-level rollout started in the agent's folder is used", () => {
  const home = join(root, "codex");
  writeRollout(home, "2026/11/15", "older", lines(meta("/work/app", "older"), userItem("yesterday's task")), 60_000);
  writeRollout(home, "2026/11/16", "other-folder", lines(meta("/work/other", "other-folder"), userItem("not this one")));
  writeRollout(home, "2026/11/16", "sub", lines(meta("/work/app", "sub", { subagent: { thread_spawn: {} } }), userItem("a subagent's brief")));
  writeRollout(home, "2026/11/16", "mine", lines(meta("/work/app", "mine"), userItem("find flights to Tokyo")), 10_000);
  const env = { CODEX_HOME: home };
  expect(agentPrompt({ env, cwd: "/work/app", parent: 0, agent: "codex" })).toBe("find flights to Tokyo");
  expect(agentPrompt({ env: { ...env, CODEX_THREAD_ID: "older" }, cwd: "/work/app", parent: 0 })).toBe("yesterday's task");
  // Codex's sessions are looked at only for Codex.
  expect(agentPrompt({ env, cwd: "/work/app", parent: 0, agent: "grok" })).toBeUndefined();
});
