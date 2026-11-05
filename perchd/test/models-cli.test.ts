import { expect, test } from "bun:test";
import { parseModelSpec, parseRoleArg } from "../src/models-cli";

test("model specs name a role, a provider, or a provider and model", () => {
  expect(parseModelSpec("role:deep")).toEqual({ role: "deep" });
  expect(parseModelSpec("codex")).toEqual({ provider: "codex" });
  expect(parseModelSpec("anthropic:claude-opus-5-5")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
  expect(parseModelSpec("ollama:qwen3:8b")).toEqual({ provider: "ollama", model: "qwen3:8b" });
  expect(() => parseModelSpec("role:image")).toThrow("generate");
  expect(() => parseModelSpec("nope:x")).toThrow("Unknown provider");
});

test("role arguments take a model and an optional effort", () => {
  expect(parseRoleArg(["deep", "openai:gpt-6-astra", "high"])).toEqual({ role: "deep", choice: { provider: "openai", model: "gpt-6-astra", effort: "high" } });
  expect(parseRoleArg(["fast", "clear"])).toEqual({ role: "fast", choice: null });
  expect(() => parseRoleArg(["deep", "openai"])).toThrow("provider:model");
  expect(() => parseRoleArg(["deep", "openai:x", "huge"])).toThrow("effort");
  expect(() => parseRoleArg(["sideways", "openai:x"])).toThrow("role");
});
