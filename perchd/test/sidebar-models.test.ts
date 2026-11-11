import { expect, test } from "bun:test";
import { bundledModels } from "@neelsatyavolu/shared-ai-auth";
import type { StepEvent } from "../src/agent/loop";
import type { RunnerInput } from "../src/app/runs";
import { SidebarRuns, sidebarModels, sidebarRunner, type OwnLoop } from "../src/app/sidebar-runner";

test("chat models come from shared-ai-auth: CLIs when installed, Claude and Grok when signed in", () => {
  const none = sidebarModels(bundledModels, [], () => false);
  expect(none).toEqual([]);
  const ids = sidebarModels(bundledModels, ["claude"], (agent) => agent === "claude-code").map((m) => m.id);
  expect(ids).toEqual([
    "claude:claude-fable-5-2", "claude:claude-opus-5-5", "claude:claude-sonnet-5-5", "claude:claude-haiku-5-5",
    "claude-code:claude-fable-5-2", "claude-code:claude-opus-5-5", "claude-code:claude-sonnet-5-5", "claude-code:claude-haiku-5-5",
  ]);
  const all = sidebarModels(bundledModels, ["claude", "grok"], () => true);
  expect(all.find((m) => m.id === "codex:gpt-6.1-sol")?.label).toBe("GPT-6.1 Sol");
  expect(all.some((m) => m.id === "grok:grok-4.7")).toBe(true);
  expect(all.find((m) => m.id === "claude:claude-fable-5-2")).toMatchObject({ label: "Claude Fable 5.2", provider: "Claude" });
});

test("a chat on a directly called model runs Perch's own loop in the chat's session", async () => {
  const runs = new SidebarRuns();
  let seen: Parameters<OwnLoop>[0] | undefined;
  let during: unknown;
  const ownLoop: OwnLoop = async function* (run) {
    seen = run;
    during = runs.get(run.session);
    yield { type: "final", text: "done" };
  };
  const runner = sidebarRunner({ runs, perch: { command: "perch", args: [] }, home: "/tmp", auditPath: "/tmp/a", ownLoop });
  const input = { task: "Find it", settings: { mode: "guard", model: "claude:claude-opus-5-5", effort: "medium", scope: "current" }, approve: async () => true, signal: new AbortController().signal, chatId: "c1" } as unknown as RunnerInput;
  const events: StepEvent[] = [];
  for await (const e of runner(input)) events.push(e);
  expect(events).toEqual([{ type: "final", text: "done" }]);
  expect(seen).toMatchObject({ provider: "claude", model: "claude-opus-5-5", session: "chat-c1", mode: "guard" });
  expect(during).toBeTruthy();
  expect(runs.get("chat-c1")).toBeUndefined();
});
