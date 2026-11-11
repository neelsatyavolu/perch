import { expect, test } from "bun:test";
import { bundledModels } from "@neelsatyavolu/shared-ai-auth";
import { catalogEfforts, fitEffort, loopEffort } from "../src/app/effort";
import { sidebarModels } from "../src/app/sidebar-runner";

test("an effort the model does not take falls to the nearest one below, else its lowest", () => {
  expect(fitEffort(["low", "medium", "high", "xhigh", "max"], "ultra")).toBe("max");
  expect(fitEffort(["low", "medium", "high"], "xhigh")).toBe("high");
  expect(fitEffort(["medium", "high"], "low")).toBe("medium");
  expect(fitEffort(["low", "medium", "high"], "medium")).toBe("medium");
  expect(fitEffort(undefined, "ultra")).toBe("ultra");
});

test("catalog efforts keep known names and default to low, medium and high", () => {
  expect(catalogEfforts(["low", "turbo", "ultra"])).toEqual(["low", "ultra"]);
  expect(catalogEfforts(undefined)).toEqual(["low", "medium", "high"]);
  expect(loopEffort("ultra")).toBe("max");
  expect(loopEffort("xhigh")).toBe("xhigh");
});

test("each chat model offers exactly the efforts the catalog lists for it", () => {
  const all = sidebarModels(bundledModels, ["claude", "grok"], () => true);
  const efforts = (id: string) => all.find((m) => m.id === id)?.efforts;
  expect(efforts("codex:gpt-6-astra")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(efforts("codex:gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(efforts("codex:default")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(efforts("claude-code:claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(efforts("claude:claude-haiku-5-5")).toEqual(["low", "medium", "high"]);
  expect(efforts("grok:grok-4.7")).toEqual(["low", "medium", "high"]);
});
