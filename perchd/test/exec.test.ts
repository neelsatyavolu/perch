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
  expect(() => parseExecArgs(["exec", "--model", "openai/gpt-5.5", "x"])).toThrow('provider "openai" needs Perch\'s own sign-in, which is not built yet; use claude-code/<model> or codex/<model>');
  expect(() => parseExecArgs(["exec"])).toThrow("give the task in quotes");
});
