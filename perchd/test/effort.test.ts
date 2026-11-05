import { expect, test } from "bun:test";
import { describeModel } from "../src/models/catalog";
import { adapterEffort } from "../src/models/factory";
import type { ProviderId } from "../src/models/ids";
import { validateRoleChoice, type Availability } from "../src/models/roles";

test("each effort the role menu offers maps to a value the provider's API takes", () => {
  // "off" is the lowest reasoning setting on the Responses API, not "send nothing" (which means medium).
  expect(adapterEffort("openai", "off")).toBe("none");
  expect(adapterEffort("codex", "off")).toBe("none");
  expect(adapterEffort("openai", "max")).toBe("xhigh");
  // The Claude API takes low through max in output_config.effort.
  expect(adapterEffort("anthropic", "low")).toBe("low");
  expect(adapterEffort("anthropic", "max")).toBe("max");
  expect(adapterEffort("grok", "max")).toBe("high");
  expect(adapterEffort("gemini", "medium")).toBe("medium");
  expect(adapterEffort("openai", undefined)).toBeUndefined();
});

test("no model offers an effort its adapter cannot send", () => {
  const offered = (p: ProviderId, id: string) => describeModel(p, id).efforts;
  for (const p of ["grok", "xai", "gemini", "openrouter", "anthropic"] as ProviderId[]) {
    for (const id of ["grok-4.7", "gemini-3.8-flash", "claude-opus-5-5"]) {
      for (const e of offered(p, id)) expect(adapterEffort(p, e)).toBeDefined();
    }
  }
  expect(offered("openai", "gpt-6-astra")).toContain("off");
  expect(offered("anthropic", "claude-opus-5-5")).toEqual(["low", "medium", "high", "max"]);
  // The Claude Code runner has no effort setting, so its models offer none.
  expect(offered("claude-code", "claude-opus-5-5")).toEqual([]);
});

test("a role cannot ask for an effort the model does not take, off included", () => {
  const a: Availability = new Map([
    ["grok", [describeModel("grok", "grok-4.7")]],
    ["claude-code", [describeModel("claude-code", "claude-opus-5-5")]],
  ]);
  expect(() => validateRoleChoice("fast", { provider: "grok", model: "grok-4.7", effort: "off" }, a)).toThrow("effort");
  expect(() => validateRoleChoice("deep", { provider: "claude-code", model: "claude-opus-5-5", effort: "max" }, a)).toThrow("effort");
});
