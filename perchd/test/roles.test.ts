import { expect, test } from "bun:test";
import { defaultSettings, type Settings } from "../src/config/store";
import { describeModel } from "../src/models/catalog";
import type { ProviderId } from "../src/models/ids";
import { resolveRoles, validateRoleChoice, type Availability } from "../src/models/roles";

const avail = (entries: [ProviderId, string[]][]): Availability => new Map(entries.map(([p, ids]) => [p, ids.map((id) => describeModel(p, id))]));
const withRoles = (roles: Settings["roles"]): Settings => ({ ...defaultSettings(), roles });

test("nothing connected: every role is empty", () => {
  const roles = resolveRoles(defaultSettings(), new Map());
  expect(Object.values(roles).every((r) => r === null)).toBe(true);
});

test("ChatGPT alone fills all six roles with its own tiers", () => {
  const roles = resolveRoles(defaultSettings(), avail([["codex", ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]]]));
  expect(roles.default).toMatchObject({ provider: "codex", model: "gpt-6-astra", source: "default" });
  expect(roles.deep?.model).toBe("gpt-6-astra");
  expect(roles.standard?.model).toBe("gpt-6.1-sol");
  expect(roles.fast?.model).toBe("gpt-6-luna");
  expect(roles.visual?.model).toBe("gpt-6.1-sol");
  expect(roles.image).toMatchObject({ provider: "codex", model: "gpt-image-2.5-sunburst" });
});

test("subscriptions come before API keys; image goes to a provider that makes images", () => {
  const roles = resolveRoles(defaultSettings(), avail([["anthropic", ["claude-opus-5-5"]], ["claude-code", []], ["gemini", []]]));
  expect(roles.default).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5" });
  // Claude Code runs whole tasks, so it cannot be the Visual model; the Anthropic key can.
  expect(roles.visual).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
  expect(roles.image).toMatchObject({ provider: "gemini", model: "gemini-nano-banana-2.1" });
});

test("a local server alone uses its first suitable model; vision only for Visual", () => {
  const roles = resolveRoles(defaultSettings(), avail([["ollama", ["nomic-embed-text", "qwen3:8b", "llava:13b"]]]));
  expect(roles.default).toMatchObject({ provider: "ollama", model: "qwen3:8b" });
  expect(roles.visual).toMatchObject({ provider: "ollama", model: "llava:13b" });
  expect(roles.image).toBeNull();
});

test("an explicit choice is kept with its effort and fast setting", () => {
  const settings = withRoles({ deep: { provider: "anthropic", model: "claude-opus-5-5", effort: "max", fast: true } });
  const roles = resolveRoles(settings, avail([["codex", []], ["anthropic", ["claude-opus-5-5", "claude-sonnet-5-5"]]]));
  expect(roles.deep).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", effort: "max", fast: true, source: "chosen" });
});

test("a choice whose provider is gone falls back and says why", () => {
  const settings = withRoles({ deep: { provider: "openai", model: "gpt-6-astra" } });
  const roles = resolveRoles(settings, avail([["grok", ["grok-4.7"]]]));
  expect(roles.deep).toMatchObject({ provider: "grok", model: "grok-4.7", source: "fallback" });
  expect(roles.deep?.note).toBe("OpenAI is not connected, so Grok 4.7 is used.");
});

test("a retired model falls back to the provider's default", () => {
  const settings = withRoles({ standard: { provider: "codex", model: "gpt-5-old" } });
  const roles = resolveRoles(settings, avail([["codex", ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]]]));
  expect(roles.standard).toMatchObject({ model: "gpt-6.1-sol", source: "fallback" });
  expect(roles.standard?.note).toContain("gpt-5-old is no longer offered");
});

test("an effort the model does not take is dropped", () => {
  const settings = withRoles({ fast: { provider: "grok", model: "grok-4.7", effort: "max" } });
  const roles = resolveRoles(settings, avail([["grok", ["grok-4.7"]]]));
  expect(roles.fast?.effort).toBeUndefined();
});

test("validateRoleChoice explains what is wrong", () => {
  const a = avail([["ollama", ["qwen3:8b", "llava:13b"]], ["openai", ["gpt-6-astra", "gpt-image-2.5-flare"]], ["claude-code", []]]);
  expect(() => validateRoleChoice("deep", { provider: "anthropic", model: "claude-opus-5-5" }, a)).toThrow("Connect Anthropic first");
  expect(() => validateRoleChoice("deep", { provider: "ollama", model: "missing" }, a)).toThrow("does not offer missing");
  expect(() => validateRoleChoice("visual", { provider: "ollama", model: "qwen3:8b" }, a)).toThrow("cannot read images");
  expect(() => validateRoleChoice("image", { provider: "openai", model: "gpt-6-astra" }, a)).toThrow("cannot make images");
  expect(() => validateRoleChoice("image", { provider: "ollama", model: "llava:13b" }, a)).toThrow("cannot make images");
  expect(() => validateRoleChoice("deep", { provider: "openai", model: "gpt-image-2.5-flare" }, a)).toThrow("cannot use Perch's tools");
  expect(() => validateRoleChoice("visual", { provider: "claude-code", model: "claude-opus-5-5" }, a)).toThrow("Claude Code");
  expect(() => validateRoleChoice("deep", { provider: "ollama", model: "qwen3:8b", effort: "high" }, a)).toThrow("effort");
  expect(validateRoleChoice("image", { provider: "openai", model: "gpt-image-2.5-flare" }, a)).toEqual({ provider: "openai", model: "gpt-image-2.5-flare" });
  expect(validateRoleChoice("deep", { provider: "claude-code", model: "claude-opus-5-5", effort: "max" }, a)).toMatchObject({ effort: "max" });
});
