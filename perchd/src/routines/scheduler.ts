/**
 * Starts routines when they are due. Runs go one at a time and a routine never overlaps itself.
 * A run that could not start on time (the Mac slept, Perch was closed, another run was going)
 * follows the routine's missed-run policy: run once now, or skip and record it. Either way the
 * next run is computed from now, so a long sleep never causes a burst of runs.
 */

import { newId } from "../memory/page";
import { nextRun } from "./schedule";
import type { Routine, RoutineStore, RunRecord, RunTrigger } from "./store";

export type RunFn = (routine: Routine, trigger: RunTrigger, scheduledFor: Date | null) => Promise<RunRecord>;
export type SchedulerOptions = { store: RoutineStore; run: RunFn; now?: () => Date; graceMs?: number };

const DEFAULT_GRACE_MS = 10 * 60_000;
const MAX_SLEEP_MS = 60_000;

export class Scheduler {
  private lane: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private ticking = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;
  private readonly grace: number;

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  }

  /** Routines queued or running now. */
  busy(): string[] {
    return [...this.active];
  }

  /** Queues a run behind any other; refuses a routine that is already queued or running. */
  private enqueue(routine: Routine, trigger: RunTrigger, scheduledFor: Date | null, run: RunFn = this.opts.run): Promise<RunRecord> {
    if (this.active.has(routine.id)) return Promise.reject(new Error("This routine is already running."));
    this.active.add(routine.id);
    const result = this.lane.then(() => this.start_(routine.id, trigger, scheduledFor, run)).finally(() => this.active.delete(routine.id));
    this.lane = result.catch(() => undefined);
    return result;
  }

  /** When a run's turn comes: use the routine as it is now; a scheduled run of a paused or deleted routine does not start. */
  private async start_(id: string, trigger: RunTrigger, scheduledFor: Date | null, run: RunFn): Promise<RunRecord> {
    const latest = this.opts.store.get(id);
    if (!latest) throw new Error("This routine was deleted before it started.");
    if (trigger !== "manual" && !latest.enabled) return this.recordSkip(latest, scheduledFor ?? this.now(), this.now(), "Paused before it started.");
    return run(latest, trigger, scheduledFor);
  }

  /** Runs a routine now, for example from "Run now"; `run` lets the caller attach its approval prompt. */
  runNow(id: string, run?: RunFn): Promise<RunRecord> {
    const routine = this.opts.store.get(id);
    if (!routine) return Promise.reject(new Error("There is no such routine."));
    return this.enqueue(routine, "manual", null, run);
  }

  /** Checks every routine once and runs the due ones. */
  async tick(): Promise<RunRecord[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: Promise<RunRecord>[] = [];
    try {
      for (const routine of this.opts.store.list()) {
        if (!routine.enabled || routine.schedule.kind !== "cron") continue;
        const now = this.now();
        const next = nextRun(routine.schedule, now);
        const due = routine.nextRunAt ? new Date(routine.nextRunAt) : null;
        if (!due) {
          await this.opts.store.save({ ...routine, nextRunAt: next?.toISOString() ?? null });
          continue;
        }
        if (due.getTime() > now.getTime()) continue;
        const current = await this.opts.store.save({ ...routine, nextRunAt: next?.toISOString() ?? null });
        const late = now.getTime() - due.getTime();
        if (this.active.has(routine.id)) continue;
        if (late <= this.grace) started.push(this.enqueue(current, "schedule", due));
        else if (routine.missed === "run_once") started.push(this.enqueue(current, "catch_up", due));
        else await this.recordSkip(current, due, now, `Missed at ${due.toISOString()} while the Mac was asleep or Perch was closed.`);
      }
    } finally {
      this.ticking = false;
    }
    return Promise.all(started);
  }

  private async recordSkip(routine: Routine, due: Date, now: Date, note: string): Promise<RunRecord> {
    const at = now.toISOString();
    const record: RunRecord = {
      id: newId(),
      routineId: routine.id,
      trigger: "schedule",
      scheduledFor: due.toISOString(),
      startedAt: at,
      finishedAt: at,
      status: "skipped",
      answer: "",
      declined: [],
      chatId: null,
      note,
    };
    await this.opts.store.addRun(record);
    return record;
  }

  /** Ticks now and then at least once a minute, so runs missed during sleep are caught on wake. */
  start(): void {
    if (this.timer) return;
    const loop = async () => {
      await this.tick().catch(() => undefined);
      if (!this.timer) return;
      this.timer = setTimeout(loop, this.delay());
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  started(): boolean {
    return this.timer !== null;
  }

  private delay(): number {
    const now = this.now().getTime();
    const soonest = Math.min(
      ...this.opts.store
        .list()
        .filter((r) => r.enabled && r.nextRunAt)
        .map((r) => new Date(r.nextRunAt!).getTime() - now),
    );
    return Math.max(1000, Math.min(MAX_SLEEP_MS, Number.isFinite(soonest) ? soonest : MAX_SLEEP_MS));
  }
}
