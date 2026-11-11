import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../src/agent/loop";
import { ArtifactStore } from "../src/app/artifacts";
import { ChatStore } from "../src/app/chats";
import { memoryKeychain } from "../src/app/keychain";
import type { AppEvent } from "../src/app/protocol";
import { RunManager, type RunnerInput } from "../src/app/runs";
import { SCHEDULE_MESSAGE, scheduleExtraTools, sidebarExtras } from "../src/app/sidebar-extras";
import { Vault } from "../src/app/vault";

let dir: string;
let chats: ChatStore;
let artifacts: ArtifactStore;
let events: AppEvent[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-sched-"));
  const vault = await Vault.open(memoryKeychain(), "Default");
  chats = await ChatStore.load(join(dir, "chats"), vault);
  artifacts = await ArtifactStore.load(join(dir, "artifacts"), vault);
  events = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("an agent schedules a message; at that time the chat sends it, pre-approved ones under Skip", async () => {
  let clock = Date.parse("2026-11-10T20:00:00Z");
  const inputs: RunnerInput[] = [];
  const runs = new RunManager({
    chats, artifacts, emit: (e) => events.push(e), artifactUrl: (id, v) => `http://art/${id}/${v}`, tabs: () => [],
    runner: async function* (input): AsyncIterable<StepEvent> {
      inputs.push(input);
      if (inputs.length === 1) await input.schedule!(new Date("2026-11-11T08:00:00Z"), "publish the Thanksgiving draft", true);
      yield { type: "final", text: "Done." };
    },
  });
  (runs.scheduler as unknown as { deps: { now: () => number } }).deps.now = () => clock;
  const chat = await chats.create({ settings: { mode: "guard", model: "fake", effort: "high" } });
  await runs.send(chat.id, "publish the Thanksgiving draft at 12am");
  await runs.idle();
  expect(chats.get(chat.id)!.scheduled).toEqual([expect.objectContaining({ text: "publish the Thanksgiving draft", preapproved: true })]);

  await runs.scheduler.tick();
  expect(inputs.length).toBe(1); // not due yet
  clock = Date.parse("2026-11-11T08:00:30Z");
  await runs.scheduler.tick();
  await runs.idle();
  expect(inputs.length).toBe(2);
  expect(inputs[1]!.settings.mode).toBe("skip");
  expect(chats.get(chat.id)!.scheduled).toEqual([]);
  const sent = chats.get(chat.id)!.messages.filter((m) => m.role === "user").at(-1)!;
  expect(sent).toMatchObject({ text: "publish the Thanksgiving draft", scheduled: true });
});

test("a message that came due long ago becomes a note instead of running; one in a busy chat waits", async () => {
  let clock = Date.parse("2026-11-10T20:00:00Z");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runs = new RunManager({
    chats, artifacts, emit: (e) => events.push(e), artifactUrl: (id, v) => `http://art/${id}/${v}`, tabs: () => [],
    runner: async function* (): AsyncIterable<StepEvent> {
      await gate;
      yield { type: "final", text: "Done." };
    },
  });
  (runs.scheduler as unknown as { deps: { now: () => number } }).deps.now = () => clock;
  const stale = await chats.create({ settings: { mode: "guard", model: "fake", effort: "high" } });
  await runs.scheduler.add(stale.id, new Date("2026-11-10T21:00:00Z"), "post the recap", false);
  const busy = await chats.create({ settings: { mode: "guard", model: "fake", effort: "high" } });
  await runs.send(busy.id, "working on something");
  await runs.scheduler.add(busy.id, new Date("2026-11-11T11:59:00Z"), "then this", false);
  clock = Date.parse("2026-11-11T12:00:00Z"); // 15 h after the first; the second is a minute late
  await runs.scheduler.tick();
  expect(chats.get(stale.id)!.messages.at(-1)!.text).toContain("I didn't send the message scheduled");
  expect(chats.get(stale.id)!.scheduled).toEqual([]);
  expect(chats.get(busy.id)!.scheduled!.map((s) => s.text)).toEqual(["then this"]); // the chat is busy: it waits
  release();
  await runs.idle();
  await runs.scheduler.tick();
  expect(chats.get(busy.id)!.scheduled).toEqual([]);
  expect(chats.get(busy.id)!.messages.some((m) => m.text === "then this" && m.scheduled)).toBe(true);
  await runs.idle();
});

test("past times and times too far ahead are refused", async () => {
  const runs = new RunManager({ chats, artifacts, emit: () => {}, artifactUrl: () => "", tabs: () => [], runner: async function* () {} });
  const chat = await chats.create({ settings: { mode: "guard", model: "fake", effort: "high" } });
  await expect(runs.scheduler.add(chat.id, new Date(Date.now() - 60_000), "x", false)).rejects.toThrow("already passed");
  await expect(runs.scheduler.add(chat.id, new Date(Date.now() + 40 * 86_400_000), "x", false)).rejects.toThrow("31 days");
  await expect(runs.scheduler.add(chat.id, new Date("not a date"), "x", false)).rejects.toThrow("isn't a date");
});

test("schedule_message checks its arguments, says when, and a pre-approved one always shows its card", async () => {
  const added: [Date, string, boolean][] = [];
  const tool = scheduleExtraTools(async (at, text, pre) => (added.push([at, text, pre]), { at: at.toISOString() }), () => new Date("2026-11-10T16:45:00"));
  const call = (args: Record<string, unknown>) => ({ id: "1", name: SCHEDULE_MESSAGE, args });
  expect(tool.prompt()).toContain("It is now Tuesday, November 10, 2026");
  expect(tool.check(call({ at: "midnight", text: "x" }))).toContain("date and time");
  expect(tool.check(call({ at: "2026-11-11T00:00", text: "" }))).toBe("text is required");
  expect(tool.describe(call({ at: "2026-11-11T00:00", text: "publish", preapprove: true })).summary).toContain("without asking");
  await tool.run(call({ at: "2026-11-11T00:00", text: "publish", preapprove: true }), new AbortController().signal);
  expect(added[0]![1]).toBe("publish");
  expect(added[0]![2]).toBe(true);
  const extras = sidebarExtras(undefined, undefined, [], async (at) => ({ at: at.toISOString() }))!;
  expect(extras.mustAsk(call({ at: "2026-11-11T00:00", text: "x", preapprove: true }))).toBe(true);
  expect(extras.mustAsk(call({ at: "2026-11-11T00:00", text: "x" }))).toBe(false);
});
