/**
 * Saved routines, their runs and each run's chat, as encrypted records (spec 11.1). Everything
 * is decrypted once at open and kept in RAM; every change is written through.
 */

import type { StepEvent } from "../agent/loop";
import type { Mode } from "../agent/permissions";
import type { KeyStore } from "../memory/keychain";
import { RecordFolder } from "../memory/records";
import type { Schedule } from "./schedule";

export type MissedPolicy = "run_once" | "skip";
export type Routine = {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly schedule: Schedule;
  readonly enabled: boolean;
  readonly mode: Mode;
  /** A model id such as "anthropic:claude-sonnet-5-5"; empty means the profile's default model. */
  readonly model?: string;
  readonly missed: MissedPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
};
export type RunTrigger = "schedule" | "manual" | "catch_up";
export type RunStatus = "ok" | "needs_approval" | "error" | "skipped" | "cancelled";
export type RunRecord = {
  readonly id: string;
  readonly routineId: string;
  readonly trigger: RunTrigger;
  readonly scheduledFor: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RunStatus;
  readonly answer: string;
  /** What the run wanted to do but could not without the user. */
  readonly declined: readonly string[];
  readonly chatId: string | null;
  readonly note?: string;
};
export type RoutineChat = {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly routineId: string;
  readonly runId: string;
  readonly task: string;
  readonly events: readonly StepEvent[];
};

const ROUTINES = "routines";
const RUNS = "runs";
const CHATS = "chats";
const RUNS_KEPT = 100;

export class RoutineStore {
  private readonly routines = new Map<string, Routine>();
  private readonly runList: RunRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** Records that could not be decrypted at open; shown to the user, never silently dropped. */
  damaged: string[] = [];

  private constructor(private readonly folder: RecordFolder) {}

  static async open(dir: string, keys: KeyStore, profile: string, opts: { createKey?: boolean } = {}): Promise<RoutineStore> {
    const store = new RoutineStore(await RecordFolder.open(dir, keys, profile, opts));
    const saved = await store.folder.all(ROUTINES);
    for (const r of saved.records) {
      const routine = JSON.parse(r.text) as Routine;
      store.routines.set(routine.id, routine);
    }
    const runRecords = await store.folder.all(RUNS);
    store.damaged = [...saved.damaged, ...runRecords.damaged];
    const runs = runRecords.records.map((r) => JSON.parse(r.text) as RunRecord);
    store.runList.push(...runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)));
    return store;
  }

  list(): Routine[] {
    return [...this.routines.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  get(id: string): Routine | null {
    return this.routines.get(id) ?? null;
  }

  /** Runs writes one at a time, so the scheduler, the runner and the Routines page never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  save(routine: Routine): Promise<Routine> {
    return this.exclusive(async () => {
      await this.folder.put(ROUTINES, routine.id, JSON.stringify(routine));
      this.routines.set(routine.id, routine);
      return routine;
    });
  }

  /** Deletes a routine with its runs and their chats. */
  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      for (const run of this.runList.filter((r) => r.routineId === id)) await this.dropRun(run);
      await this.folder.remove(ROUTINES, id);
      this.routines.delete(id);
    });
  }

  /** Newest first. */
  runs(routineId?: string, limit = 50): RunRecord[] {
    return this.runList.filter((r) => !routineId || r.routineId === routineId).slice(0, limit);
  }

  addRun(run: RunRecord): Promise<void> {
    return this.exclusive(async () => {
      await this.folder.put(RUNS, run.id, JSON.stringify(run));
      this.runList.unshift(run);
      const old = this.runList.filter((r) => r.routineId === run.routineId).slice(RUNS_KEPT);
      for (const r of old) await this.dropRun(r);
    });
  }

  private async dropRun(run: RunRecord): Promise<void> {
    if (run.chatId) await this.folder.remove(CHATS, run.chatId);
    await this.folder.remove(RUNS, run.id);
    const i = this.runList.indexOf(run);
    if (i >= 0) this.runList.splice(i, 1);
  }

  async saveChat(chat: RoutineChat): Promise<void> {
    await this.folder.put(CHATS, chat.id, JSON.stringify(chat));
  }

  async getChat(id: string): Promise<RoutineChat | null> {
    const text = await this.folder.get(CHATS, id);
    return text ? (JSON.parse(text) as RoutineChat) : null;
  }
}
