import { expect, test } from "bun:test";
import { TaskStatusReporter } from "../src/app/task-status";
import type { ApprovalCard } from "../src/app/protocol";

function setup(targets: Record<string, string[]>) {
  const calls: unknown[] = [];
  const reporter = new TaskStatusReporter({
    perch: { setTaskStatus: async (p) => (calls.push(p), {}) },
    targets: (id) => targets[id] ?? [],
    refreshMs: 60_000,
  });
  return { calls, reporter };
}

const card = { id: "a", chatId: "c1", runId: "r", title: "Send message to Alex", site: "mail.example", kind: "risky", confirm: "Send message", danger: false } as ApprovalCard;

test("running marks the chat's tabs, waiting carries the card title, idle clears the same tabs", () => {
  const targets: Record<string, string[]> = { c1: ["t2", "t1"] };
  const { calls, reporter } = setup(targets);
  reporter.update("c1", "running", null);
  reporter.update("c1", "waiting", card);
  targets.c1 = ["t1"];
  reporter.update("c1", "idle", null);
  reporter.stop();
  expect(calls).toEqual([
    { chatId: "c1", status: "running", targetIds: ["t1", "t2"] },
    { chatId: "c1", status: "waiting", targetIds: ["t1", "t2"], title: "Send message to Alex" },
    { chatId: "c1", status: "idle", targetIds: ["t1", "t2"] },
  ]);
});

test("only changes reach the browser; a new agent tab is picked up on refresh", () => {
  const targets: Record<string, string[]> = { c1: ["t1"] };
  const { calls, reporter } = setup(targets);
  reporter.update("c1", "running", null);
  reporter.update("c1", "running", null);
  reporter.refresh();
  targets.c1 = ["t1", "t3"];
  reporter.refresh();
  reporter.stop();
  expect(calls.length).toBe(2);
  expect(calls[1]).toEqual({ chatId: "c1", status: "running", targetIds: ["t1", "t3"] });
});

test("idle for a chat that never ran sends nothing", () => {
  const { calls, reporter } = setup({});
  reporter.update("c9", "idle", null);
  expect(calls).toEqual([]);
});
