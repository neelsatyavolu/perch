import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import type { ApprovalRequest, StepEvent, TaskOptions } from "../src/agent/loop";
import type { Browser } from "../src/browser/browser";
import { mockKeychain, type KeyStore } from "../src/memory/keychain";
import { fakeModel } from "../src/models/fake";
import { runRoutine, type RunnerDeps } from "../src/routines/runner";
import { Scheduler } from "../src/routines/scheduler";
import { RoutineStore, type Routine } from "../src/routines/store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "perch-routines-"));
  dirs.push(d);
  return d;
};
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

let clock = new Date("2026-11-05T15:00:00Z");
const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "0123456789abcdef0123456789abcdef",
  name: "Teacher mail",
  task: "Summarise new mail from my teachers",
  schedule: { kind: "cron", expr: "0 8 * * 1-5" },
  enabled: true,
  mode: "guard",
  missed: "run_once",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  lastRunAt: null,
  nextRunAt: null,
  ...over,
});

async function openStore(keys: KeyStore = mockKeychain(), dir = temp()) {
  return { store: await RoutineStore.open(dir, keys, "default"), dir, keys };
}

/** A runTask stand-in that plays scripted approval requests, then finishes. */
function fakeRunTask(requests: ApprovalRequest[], seen: TaskOptions[]) {
  return async function* (opts: TaskOptions): AsyncIterable<StepEvent> {
    seen.push(opts);
    const answers: boolean[] = [];
    for (const request of requests) {
      yield { type: "approval", request };
      answers.push(await opts.approve(request));
    }
    yield { type: "step", label: "Opened mail.google.com" };
    yield { type: "final", text: `Done. Approvals: ${answers.join(",") || "none"}` };
  };
}

function deps(store: RoutineStore, runTask: RunnerDeps["runTask"], extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    store,
    audit: new AuditLog(join(temp(), "audit.jsonl")),
    browser: async () => ({}) as Browser,
    model: async () => fakeModel([]),
    runTask,
    now: () => clock,
    ...extra,
  };
}

const payment: ApprovalRequest = { call: { id: "1", name: "click", args: { ref: "e1" } }, kind: "payment", site: "shop.example", summary: "Click button \"Place order\" on shop.example" };
const risky: ApprovalRequest = { call: { id: "2", name: "click", args: { ref: "e2" } }, kind: "risky", site: "mail.google.com", summary: "Click button \"Send\" on mail.google.com" };

test("routines, runs and chats are encrypted on disk and survive a reopen", async () => {
  const { store, dir, keys } = await openStore();
  await store.save(routine({ task: "CANARYTASK summarise mail from Ms Quixote" }));
  const again = await RoutineStore.open(dir, keys, "default");
  expect(again.get(routine().id)!.task).toBe("CANARYTASK summarise mail from Ms Quixote");
  for (const f of walk(dir)) for (const w of ["CANARYTASK", "Quixote", "Teacher"]) expect(readFileSync(f).includes(Buffer.from(w))).toBe(false);
});

test("an unattended run declines every approval, never pays, and keeps the result as a chat", async () => {
  const { store } = await openStore();
  await store.save(routine({ mode: "skip" }));
  const seen: TaskOptions[] = [];
  const run = await runRoutine(store.get(routine().id)!, "schedule", deps(store, fakeRunTask([payment, risky], seen)));
  expect(run).toMatchObject({ status: "needs_approval", trigger: "schedule", answer: "Done. Approvals: false,false" });
  expect(run.declined).toEqual(['Click button "Place order" on shop.example', 'Click button "Send" on mail.google.com']);
  expect(seen[0]!.mode).toBe("skip");
  expect(seen[0]!.client).toBe(`routine:${routine().id}`);
  expect(seen[0]!.task).toContain("Summarise new mail from my teachers");
  expect(seen[0]!.task).toContain("Nobody can approve actions now");
  const chat = await store.getChat(run.chatId!);
  expect(chat).toMatchObject({ title: "Teacher mail", routineId: routine().id, runId: run.id });
  expect(chat!.events.map((e) => e.type)).toEqual(["approval", "approval", "step", "final"]);
  expect(store.runs(routine().id)[0]!.id).toBe(run.id);
  expect(store.get(routine().id)!.lastRunAt).toBe(clock.toISOString());
});

test("a manual run with someone watching asks them, payments included", async () => {
  const { store } = await openStore();
  await store.save(routine());
  const asked: string[] = [];
  const run = await runRoutine(store.get(routine().id)!, "manual", deps(store, fakeRunTask([payment], [])), {
    approve: async (req) => (asked.push(req.kind), true),
  });
  expect(asked).toEqual(["payment"]);
  expect(run).toMatchObject({ status: "ok", answer: "Done. Approvals: true", declined: [] });
});

test("a failing model or browser ends the run with a plain error, and it is still recorded", async () => {
  const { store } = await openStore();
  await store.save(routine());
  const run = await runRoutine(store.get(routine().id)!, "schedule", deps(store, fakeRunTask([], []), { model: async () => { throw new Error("Sign in to a model first."); } }));
  expect(run).toMatchObject({ status: "error", answer: "Sign in to a model first.", chatId: null });
  const errorTask = async function* (): AsyncIterable<StepEvent> { yield { type: "error", message: "Stopped after 40 steps" }; };
  const second = await runRoutine(store.get(routine().id)!, "schedule", deps(store, errorTask));
  expect(second).toMatchObject({ status: "error", answer: "Stopped after 40 steps" });
  expect(store.runs(routine().id)).toHaveLength(2);
});

test("a run that goes on too long is cancelled", async () => {
  const { store } = await openStore();
  await store.save(routine());
  const slow = async function* (opts: TaskOptions): AsyncIterable<StepEvent> {
    await new Promise((resolve) => opts.signal!.addEventListener("abort", resolve));
    yield { type: "error", message: "Cancelled." };
  };
  const run = await runRoutine(store.get(routine().id)!, "schedule", deps(store, slow, { timeoutMs: 20 }));
  expect(run).toMatchObject({ status: "cancelled", answer: "The run took longer than its time limit and was stopped." });
});

function scheduler(store: RoutineStore, graceMs?: number) {
  const ran: { id: string; trigger: string; scheduledFor: string | null }[] = [];
  const s = new Scheduler({
    store,
    now: () => clock,
    graceMs,
    run: async (r, trigger, scheduledFor) => {
      ran.push({ id: r.id, trigger, scheduledFor: scheduledFor?.toISOString() ?? null });
      return { id: "f".repeat(32), routineId: r.id, trigger, scheduledFor: scheduledFor?.toISOString() ?? null, startedAt: clock.toISOString(), finishedAt: clock.toISOString(), status: "ok", answer: "", declined: [], chatId: null };
    },
  });
  return { s, ran };
}

test("the scheduler sets the next run, runs it when due, then moves to the following one", async () => {
  const { store } = await openStore();
  await store.save(routine());
  const { s, ran } = scheduler(store);
  clock = new Date("2026-11-05T07:00:00Z");
  await s.tick();
  expect(store.get(routine().id)!.nextRunAt).toBe("2026-11-05T08:00:00.000Z");
  expect(ran).toEqual([]);
  clock = new Date("2026-11-05T08:00:30Z");
  await s.tick();
  expect(ran).toEqual([{ id: routine().id, trigger: "schedule", scheduledFor: "2026-11-05T08:00:00.000Z" }]);
  expect(store.get(routine().id)!.nextRunAt).toBe("2026-11-06T08:00:00.000Z");
  await s.tick();
  expect(ran).toHaveLength(1);
});

test("missed runs (the Mac was asleep) run once on wake, or are skipped and recorded", async () => {
  const { store } = await openStore();
  await store.save(routine({ nextRunAt: "2026-11-02T08:00:00.000Z" }));
  await store.save(routine({ id: "fedcba9876543210fedcba9876543210", name: "Skipper", missed: "skip", nextRunAt: "2026-11-02T08:00:00.000Z" }));
  await store.save(routine({ id: "00000000000000000000000000000001", name: "Paused", enabled: false, nextRunAt: "2026-11-02T08:00:00.000Z" }));
  const { s, ran } = scheduler(store);
  clock = new Date("2026-11-05T12:00:00Z");
  await s.tick();
  expect(ran).toEqual([{ id: routine().id, trigger: "catch_up", scheduledFor: "2026-11-02T08:00:00.000Z" }]);
  expect(store.runs("fedcba9876543210fedcba9876543210")[0]).toMatchObject({ status: "skipped", trigger: "schedule", note: "Missed at 2026-11-02T08:00:00.000Z while the Mac was asleep or Perch was closed." });
  expect(store.get("fedcba9876543210fedcba9876543210")!.nextRunAt).toBe("2026-11-06T08:00:00.000Z");
  expect(store.get("00000000000000000000000000000001")!.nextRunAt).toBe("2026-11-02T08:00:00.000Z");
});

test("runs never overlap: a routine already running is not started again", async () => {
  const { store } = await openStore();
  await store.save(routine({ schedule: { kind: "manual" } }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  const s = new Scheduler({
    store,
    now: () => clock,
    run: async (r, trigger) => {
      started++;
      await gate;
      return { id: "e".repeat(32), routineId: r.id, trigger, scheduledFor: null, startedAt: "", finishedAt: "", status: "ok", answer: "", declined: [], chatId: null };
    },
  });
  const first = s.runNow(routine().id);
  await expect(s.runNow(routine().id)).rejects.toThrow("already running");
  expect(s.busy()).toEqual([routine().id]);
  release();
  await first;
  expect(started).toBe(1);
  expect(s.busy()).toEqual([]);
  await expect(s.runNow("0".repeat(32))).rejects.toThrow("no such routine");
});

test("start and stop leave no timer behind", async () => {
  const { store } = await openStore();
  const { s } = scheduler(store);
  s.start();
  s.stop();
  expect(s.started()).toBe(false);
});

test("concurrent saves of one routine all land, and the last one wins", async () => {
  const { store, dir, keys } = await openStore();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(routine({ name: `Name ${i}` }))));
  expect(store.get(routine().id)!.name).toBe("Name 19");
  expect((await RoutineStore.open(dir, keys, "default")).get(routine().id)!.name).toBe("Name 19");
  expect(walk(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("a queued run uses the routine as it is when its turn comes, and a paused one does not run", async () => {
  const { store } = await openStore();
  await store.save(routine({ schedule: { kind: "manual" } }));
  await store.save(routine({ id: "fedcba9876543210fedcba9876543210", name: "Second", schedule: { kind: "manual" } }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const seen: { name: string; mode: string }[] = [];
  const s = new Scheduler({
    store,
    now: () => clock,
    run: async (r, trigger) => {
      seen.push({ name: r.name, mode: r.mode });
      if (r.id === routine().id) await gate;
      return { id: "e".repeat(32), routineId: r.id, trigger, scheduledFor: null, startedAt: "", finishedAt: "", status: "ok", answer: "", declined: [], chatId: null };
    },
  });
  const first = s.runNow(routine().id);
  const second = s.runNow("fedcba9876543210fedcba9876543210");
  await store.save({ ...store.get("fedcba9876543210fedcba9876543210")!, mode: "ask" });
  release();
  await Promise.all([first, second]);
  expect(seen).toEqual([{ name: "Teacher mail", mode: "guard" }, { name: "Second", mode: "ask" }]);

  const third = "00000000000000000000000000000003";
  await store.save(routine({ id: third, name: "Scheduled", schedule: { kind: "cron", expr: "0 8 * * *" }, nextRunAt: clock.toISOString() }));
  let releaseAgain!: () => void;
  const gateAgain = new Promise<void>((resolve) => (releaseAgain = resolve));
  const blocker = s.runNow(routine().id, async (r, trigger) => {
    await gateAgain;
    return { id: "d".repeat(32), routineId: r.id, trigger, scheduledFor: null, startedAt: "", finishedAt: "", status: "ok", answer: "", declined: [], chatId: null };
  });
  const ticked = s.tick();
  // Pause it after the tick has queued it behind the blocker.
  while (!s.busy().includes(third)) await new Promise((resolve) => setTimeout(resolve, 1));
  await store.update(third, (r) => ({ ...r, enabled: false }));
  releaseAgain();
  await blocker;
  const [skipped] = await ticked;
  expect(skipped).toMatchObject({ routineId: third, status: "skipped", note: "Paused before it started." });
  expect(seen.map((x) => x.name)).not.toContain("Scheduled");
});

test("a pause or mode change made while the scheduler is saving another routine is kept", async () => {
  const { store } = await openStore();
  const due = "2026-11-05T08:00:00.000Z";
  const [a, b, c] = ["0000000000000000000000000000000a", "0000000000000000000000000000000b", "0000000000000000000000000000000c"];
  for (const [i, id] of [a, b, c].entries()) await store.save(routine({ id, name: id.slice(-1), nextRunAt: due, createdAt: `2026-11-01T00:00:0${i}.000Z` }));
  const ran: { name: string; mode: string }[] = [];
  const s = new Scheduler({
    store,
    now: () => clock,
    run: async (r, trigger) => {
      ran.push({ name: r.name, mode: r.mode });
      return { id: "e".repeat(32), routineId: r.id, trigger, scheduledFor: null, startedAt: "", finishedAt: "", status: "ok", answer: "", declined: [], chatId: null };
    },
  });
  clock = new Date("2026-11-05T08:00:30Z");
  const ticked = s.tick();
  // The Routines page pauses B and switches C to Ask while the scheduler is writing A.
  await Promise.all([store.save({ ...store.get(b)!, enabled: false, nextRunAt: null }), store.save({ ...store.get(c)!, mode: "ask" })]);
  await ticked;
  expect(store.get(b)).toMatchObject({ enabled: false, nextRunAt: null });
  expect(store.get(c)).toMatchObject({ mode: "ask", nextRunAt: "2026-11-06T08:00:00.000Z" });
  expect(ran).toEqual([{ name: "a", mode: "guard" }, { name: "c", mode: "ask" }]);
});

test("store.update applies a change to the latest copy and skips the write when nothing changed", async () => {
  const { store } = await openStore();
  await store.save(routine());
  const [renamed, paused] = await Promise.all([store.update(routine().id, (r) => ({ ...r, name: "Renamed" })), store.update(routine().id, (r) => ({ ...r, enabled: false }))]);
  expect(renamed).toMatchObject({ name: "Renamed", enabled: true });
  expect(paused).toMatchObject({ name: "Renamed", enabled: false });
  expect(await store.update(routine().id, (r) => r)).toBe(store.get(routine().id));
  expect(await store.update("0".repeat(32), (r) => r)).toBeNull();
});

test("a routine still running when its next time comes is skipped and the skip is recorded", async () => {
  const { store } = await openStore();
  await store.save(routine({ nextRunAt: "2026-11-05T08:00:00.000Z" }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const s = new Scheduler({
    store,
    now: () => clock,
    run: async (r, trigger) => {
      await gate;
      return { id: "e".repeat(32), routineId: r.id, trigger, scheduledFor: null, startedAt: "", finishedAt: "", status: "ok", answer: "", declined: [], chatId: null };
    },
  });
  clock = new Date("2026-11-05T07:59:00Z");
  const running = s.runNow(routine().id);
  clock = new Date("2026-11-05T08:00:30Z");
  const [skipped] = await s.tick();
  expect(skipped).toMatchObject({ status: "skipped", scheduledFor: "2026-11-05T08:00:00.000Z", note: "Skipped: the previous run was still going." });
  expect(store.runs(routine().id)[0]).toMatchObject({ status: "skipped" });
  expect(store.get(routine().id)!.nextRunAt).toBe("2026-11-06T08:00:00.000Z");
  release();
  await running;
});

test("a long scheduled run does not stop a routine that comes due meanwhile from starting on time", async () => {
  const { store } = await openStore();
  const second = "fedcba9876543210fedcba9876543210";
  clock = new Date("2026-11-05T08:00:00Z");
  await store.save(routine({ nextRunAt: "2026-11-05T08:00:00.000Z" }));
  await store.save(routine({ id: second, name: "Second", missed: "skip", nextRunAt: "2026-11-05T08:00:00.500Z" }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const triggers: string[] = [];
  const s = new Scheduler({
    store,
    now: () => clock,
    run: async (r, trigger) => {
      triggers.push(`${r.name}:${trigger}`);
      if (r.id === routine().id) await gate;
      return { id: "e".repeat(32), routineId: r.id, trigger, scheduledFor: null, startedAt: "", finishedAt: "", status: "ok", answer: "", declined: [], chatId: null };
    },
  });
  s.start();
  await new Promise((r) => setTimeout(r, 50));
  expect(s.busy()).toEqual([routine().id]);
  clock = new Date("2026-11-05T08:01:00Z");
  await new Promise((r) => setTimeout(r, 1200));
  expect(s.busy()).toEqual([routine().id, second]);
  // The first run goes on well past the second's grace period; the second still runs, not "missed".
  clock = new Date("2026-11-05T08:30:00Z");
  release();
  await new Promise((r) => setTimeout(r, 50));
  s.stop();
  expect(triggers).toEqual(["Teacher mail:schedule", "Second:schedule"]);
  expect(store.runs(second).filter((r) => r.status === "skipped")).toEqual([]);
});
