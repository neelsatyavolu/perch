import { expect, test } from "bun:test";
import { parseExecArgs } from "../src/exec";

test("perch exec accepts the Aside runner's arguments", () => {
  expect(parseExecArgs(["exec", "--model", "claude-code/claude-sonnet-5-5", "--thinking", "high", "--log-dump", "/tmp/e.jsonl", "Find the price"])).toEqual({
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    thinking: "high",
    logDump: "/tmp/e.jsonl",
    task: "Find the price",
  });
  expect(parseExecArgs(["exec", "List the top 5"])).toMatchObject({ provider: "claude-code", model: "claude-sonnet-5-5", task: "List the top 5" });
  expect(parseExecArgs(["exec", "--model", "codex/gpt-6-astra", "x"])).toMatchObject({ provider: "codex", model: "gpt-6-astra" });
  // Aside's provider names run through the user's Codex and Claude Code sign-ins.
  expect(parseExecArgs(["exec", "--model", "openai/gpt-6.1-sol", "x"])).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
  expect(parseExecArgs(["exec", "-m", "anthropic/claude-opus-5-5", "x"])).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5" });
  expect(() => parseExecArgs(["exec", "--model", "google/gemini-3", "x"])).toThrow('provider "google" needs Perch\'s own sign-in');
  expect(() => parseExecArgs(["exec"])).toThrow("give the task in quotes");
});
