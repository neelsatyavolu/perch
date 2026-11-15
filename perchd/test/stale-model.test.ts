import { expect, test } from "bun:test";
import { bundledModels } from "@neelsatyavolu/shared-ai-auth";
import { offeredModel } from "../src/app/app";
import { sidebarModels } from "../src/app/sidebar-runner";

test("Claude Code shows only while it is connected in Settings → Models", () => {
  const signedOut = sidebarModels(bundledModels, ["claude"], () => true).map((m) => m.id);
  expect(signedOut.some((id) => id.startsWith("claude-code:"))).toBe(false);
  const connected = sidebarModels(bundledModels, ["claude", "claude-code"], () => true).map((m) => m.id);
  expect(connected).toContain("claude-code:claude-sonnet-5-5");
  const notInstalled = sidebarModels(bundledModels, ["claude-code"], () => false).map((m) => m.id);
  expect(notInstalled.some((id) => id.startsWith("claude-code:"))).toBe(false);
});

test("a chat saved on a model no longer offered runs the same model from another source", () => {
  const models = sidebarModels(bundledModels, ["claude"], () => true);
  expect(offeredModel("claude-code:claude-opus-5-5", models)).toBe("claude:claude-opus-5-5");
  expect(offeredModel("claude:claude-opus-5-5", models)).toBe("claude:claude-opus-5-5");
  expect(offeredModel("claude-code:no-such-model", models)).toBe("claude-code:no-such-model");
  expect(offeredModel("codex:default", models)).toBe(models.find((m) => m.id.startsWith("codex:"))!.id);
  expect(offeredModel("claude-code:claude-opus-5-5", [])).toBe("claude-code:claude-opus-5-5");
});
