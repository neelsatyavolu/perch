import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "../src/agent/loop";
import { mockKeychain } from "../src/memory/keychain";
import { createRoutinesApi } from "../src/routines/api";
import { Scheduler, type RunFn } from "../src/routines/scheduler";
import { RoutineStore, type RunRecord } from "../src/routines/store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
let clock = new Date("2026-11-05T07:00:00Z");

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "perch-routapi-"));
  dirs.push(dir);
  const store = await RoutineStore.open(dir, mockKeychain(), "default");
  const runs: { trigger: string; attended: boolean }[] = [];
  const record = (routineId: string, trigger: RunRecord["trigger"]): RunRecord => ({ id: "a".repeat(32), routineId, trigger, scheduledFor: null, startedAt: clock.toISOString(), finishedAt: clock.toISOString(), status: "ok", answer: "done", declined: [], chatId: null });
  const run: RunFn = async (r, trigger) => (runs.push({ trigger, attended: false }), record(r.id, trigger));
  const scheduler = new Scheduler({ store, run, now: () => clock });
  const runAttended = (approve: (req: ApprovalRequest) => Promise<boolean>): RunFn => async (r, trigger) => {
    runs.push({ trigger, attended: typeof approve === "function" });
    return record(r.id, trigger);
  };
  return { api: createRoutinesApi({ store, scheduler, runAttended, now: () => clock }), store, runs };
}

const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const weekdays8 = { kind: "cron", expr: "0 8 * * 1-5" };

test("create a routine: defaults, description and next run", async () => {
  const { api } = await setup();
  const r = ok(await api.create({ name: "Teacher mail", task: "Summarise new mail from my teachers", schedule: weekdays8 }));
  expect(r).toMatchObject({ mode: "guard", missed: "run_once", enabled: true, description: "Every weekday at 08:00", nextRunAt: "2026-11-05T08:00:00.000Z", lastRunAt: null });
  expect(ok(await api.list()).map((x) => x.name)).toEqual(["Teacher mail"]);
  const manual = ok(await api.create({ name: "On demand", task: "Check prices", schedule: { kind: "manual" }, mode: "ask" }));
  expect(manual).toMatchObject({ description: "Only when you run it", nextRunAt: null, mode: "ask" });
});

test("bad routines are refused with plain errors", async () => {
  const { api, store } = await setup();
  expect(await api.create({ task: "x", schedule: weekdays8 })).toEqual({ ok: false, error: "Name is required." });
  expect(await api.create({ name: "x", task: "x", schedule: { kind: "cron", expr: "*/5 * * * *" } })).toEqual({ ok: false, error: "Routines can run at most every 15 minutes." });
  expect(await api.create({ name: "x", task: "x", schedule: { kind: "cron", expr: "every day" } })).toMatchObject({ ok: false, error: expect.stringContaining("five fields") });
  expect(await api.create({ name: "x", task: "x", schedule: weekdays8, mode: "yolo" })).toEqual({ ok: false, error: "mode must be one of: ask, guard, skip." });
  expect(await api.create({ name: "x", task: "x", schedule: weekdays8, model: "rm -rf /" })).toEqual({ ok: false, error: "model is not a valid model id." });
  expect(await api.create({ name: "x", task: "y".repeat(4001), schedule: weekdays8 })).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
  expect(store.list()).toEqual([]);
});

test("edit, pause, resume and delete", async () => {
  const { api, store } = await setup();
  const r = ok(await api.create({ name: "Teacher mail", task: "Summarise", schedule: weekdays8 }));
  const edited = ok(await api.update({ id: r.id, name: "Mail digest", schedule: { kind: "cron", expr: "30 18 * * *" } }));
  expect(edited).toMatchObject({ name: "Mail digest", task: "Summarise", description: "Every day at 18:30", nextRunAt: "2026-11-05T18:30:00.000Z" });
  expect(ok(await api.setEnabled({ id: r.id, enabled: false }))).toMatchObject({ enabled: false, nextRunAt: null });
  clock = new Date("2026-11-07T20:00:00Z");
  expect(ok(await api.setEnabled({ id: r.id, enabled: true }))).toMatchObject({ enabled: true, nextRunAt: "2026-11-08T18:30:00.000Z" });
  ok(await api.remove({ id: r.id }));
  expect(store.list()).toEqual([]);
  expect(await api.get({ id: r.id })).toEqual({ ok: false, error: "There is no such routine." });
  clock = new Date("2026-11-05T07:00:00Z");
});

test("run now: attended when a prompt is given; runs are listed", async () => {
  const { api, runs } = await setup();
  const r = ok(await api.create({ name: "Prices", task: "Check prices", schedule: { kind: "manual" } }));
  ok(await api.runNow({ id: r.id }));
  ok(await api.runNow({ id: r.id }, async () => true));
  expect(runs).toEqual([{ trigger: "manual", attended: false }, { trigger: "manual", attended: true }]);
  expect(await api.chat({ chatId: "b".repeat(32) })).toEqual({ ok: false, error: "This run's chat is no longer kept." });
  expect(await api.runs({ id: "nope" })).toEqual({ ok: false, error: "id is not a valid id." });
});

test("previewSchedule shows the next five runs", async () => {
  const { api } = await setup();
  const preview = ok(await api.previewSchedule({ schedule: weekdays8 }));
  expect(preview.description).toBe("Every weekday at 08:00");
  expect(preview.next).toEqual(["2026-11-05T08:00:00.000Z", "2026-11-06T08:00:00.000Z", "2026-11-09T08:00:00.000Z", "2026-11-10T08:00:00.000Z", "2026-11-11T08:00:00.000Z"]);
});
