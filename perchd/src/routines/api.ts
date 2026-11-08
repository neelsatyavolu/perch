/**
 * Typed functions for the Routines UI: create, edit, pause, resume, delete, run now, and read
 * past runs and their chats. Input is checked here; results use the { ok, data | error } envelope.
 */

import type { ApprovalRequest } from "../agent/loop";
import { attempt, flag, id, int, oneOf, record, text, type ApiResult } from "../memory/api-input";
import { newId } from "../memory/page";
import { checkSchedule, describeSchedule, MAX_INTERVAL_HOURS, nextRun, upcoming, type Schedule } from "./schedule";
import type { RunFn, Scheduler } from "./scheduler";
import type { Routine, RoutineChat, RoutineStore, RunRecord } from "./store";

export type RoutineView = Routine & { description: string };
export type RoutinesApiDeps = {
  store: RoutineStore;
  scheduler: Scheduler;
  /** Runs a routine with an approval prompt for the person who pressed "Run now". */
  runAttended?: (approve: (request: ApprovalRequest) => Promise<boolean>) => RunFn;
  now?: () => Date;
};

const MODES = ["ask", "guard", "skip"] as const;
const MISSED = ["run_once", "skip"] as const;
const MAX_ROUTINES = 50;
const MODEL_ID = /^[\w.:/-]{1,100}$/;

function scheduleFrom(input: unknown, now: Date): Schedule {
  const s = record(input);
  const kind = oneOf(s, "kind", ["manual", "cron", "interval"] as const);
  const schedule: Schedule =
    kind === "manual" ? { kind } : kind === "interval" ? { kind, hours: int(s, "hours", { min: 1, max: MAX_INTERVAL_HOURS }) } : { kind, expr: text(s, "expr", { max: 100, label: "The schedule" }) };
  const problem = checkSchedule(schedule, now);
  if (problem) throw new Error(problem);
  return schedule;
}

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `wakeChatId` makes a heartbeat routine: it wakes that chat (app/heartbeat.ts). */
function wakeFrom(i: Record<string, unknown>): { wake?: { chatId: string } } {
  if (i.wakeChatId === undefined || i.wakeChatId === null) return {};
  if (typeof i.wakeChatId !== "string" || !CHAT_ID.test(i.wakeChatId)) throw new Error("wakeChatId is not a chat id.");
  return { wake: { chatId: i.wakeChatId } };
}

function view(r: Routine): RoutineView {
  return { ...r, description: describeSchedule(r.schedule) };
}

export function createRoutinesApi(deps: RoutinesApiDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const found = (routine: Routine | null) => {
    if (!routine) throw new Error("There is no such routine.");
    return routine;
  };
  const existing = (input: Record<string, unknown>) => found(store.get(id(input)));
  const nextAt = (r: Pick<Routine, "schedule" | "enabled">) => (r.enabled ? nextRun(r.schedule, now())?.toISOString() ?? null : null);

  return {
    list: (): Promise<ApiResult<RoutineView[]>> => attempt(() => store.list().map(view)),

    get: (input: unknown): Promise<ApiResult<RoutineView>> => attempt(() => view(existing(record(input)))),

    previewSchedule: (input: unknown): Promise<ApiResult<{ description: string; next: string[] }>> =>
      attempt(() => {
        const schedule = scheduleFrom(record(input).schedule, now());
        return { description: describeSchedule(schedule), next: upcoming(schedule, now(), 5).map((d) => d.toISOString()) };
      }),

    create: (input: unknown): Promise<ApiResult<RoutineView>> =>
      attempt(async () => {
        if (store.list().length >= MAX_ROUTINES) throw new Error(`You can keep up to ${MAX_ROUTINES} routines. Delete one first.`);
        const i = record(input);
        const model = text(i, "model", { max: 100, optional: true });
        if (model && !MODEL_ID.test(model)) throw new Error("model is not a valid model id.");
        const at = now().toISOString();
        const draft = {
          id: newId(),
          name: text(i, "name", { max: 80, label: "Name" }),
          task: text(i, "task", { max: 4000, label: "Instructions" }),
          schedule: scheduleFrom(i.schedule, now()),
          enabled: flag(i, "enabled") ?? true,
          mode: oneOf(i, "mode", MODES, "guard"),
          ...(model ? { model } : {}),
          missed: oneOf(i, "missed", MISSED, "run_once"),
          ...wakeFrom(i),
          createdAt: at,
          updatedAt: at,
          lastRunAt: null,
        };
        return view(await store.save({ ...draft, nextRunAt: nextAt(draft) }));
      }),

    update: (input: unknown): Promise<ApiResult<RoutineView>> =>
      attempt(async () => {
        const i = record(input);
        const { id: routineId } = existing(i);
        const model = i.model === undefined ? undefined : text(i, "model", { max: 100, optional: true });
        if (model && !MODEL_ID.test(model)) throw new Error("model is not a valid model id.");
        const patch: Partial<Routine> = {
          ...(i.name === undefined ? {} : { name: text(i, "name", { max: 80, label: "Name" }) }),
          ...(i.task === undefined ? {} : { task: text(i, "task", { max: 4000, label: "Instructions" }) }),
          ...(i.schedule === undefined ? {} : { schedule: scheduleFrom(i.schedule, now()) }),
          ...(i.mode === undefined ? {} : { mode: oneOf(i, "mode", MODES) }),
          ...(i.missed === undefined ? {} : { missed: oneOf(i, "missed", MISSED) }),
          ...(i.model === undefined ? {} : { model: model || undefined }),
          updatedAt: now().toISOString(),
        };
        const saved = await store.update(routineId, (latest) => {
          const next = { ...latest, ...patch };
          return { ...next, nextRunAt: patch.schedule ? nextAt(next) : latest.nextRunAt };
        });
        return view(found(saved));
      }),

    /** Pause or resume. Resuming starts from now, so runs missed while paused do not catch up. */
    setEnabled: (input: unknown): Promise<ApiResult<RoutineView>> =>
      attempt(async () => {
        const i = record(input);
        const { id: routineId } = existing(i);
        const enabled = flag(i, "enabled");
        if (enabled === undefined) throw new Error("enabled is required.");
        const updatedAt = now().toISOString();
        const saved = await store.update(routineId, (latest) => ({ ...latest, enabled, updatedAt, nextRunAt: nextAt({ ...latest, enabled }) }));
        return view(found(saved));
      }),

    remove: (input: unknown): Promise<ApiResult<null>> =>
      attempt(async () => {
        const routine = existing(record(input));
        if (deps.scheduler.busy().includes(routine.id)) throw new Error("This routine is running. Delete it after the run ends.");
        await store.remove(routine.id);
        return null;
      }),

    runNow: (input: unknown, approve?: (request: ApprovalRequest) => Promise<boolean>): Promise<ApiResult<RunRecord>> =>
      attempt(() => {
        const routine = existing(record(input));
        return deps.scheduler.runNow(routine.id, approve && deps.runAttended ? deps.runAttended(approve) : undefined);
      }),

    runs: (input: unknown = {}): Promise<ApiResult<RunRecord[]>> =>
      attempt(() => {
        const i = record(input);
        const routineId = i.id === undefined ? undefined : id(i);
        return store.runs(routineId, int(i, "limit", { min: 1, max: 100, fallback: 50 }));
      }),

    chat: (input: unknown): Promise<ApiResult<RoutineChat>> =>
      attempt(async () => {
        const chat = await store.getChat(id(record(input), "chatId"));
        if (!chat) throw new Error("This run's chat is no longer kept.");
        return chat;
      }),
  };
}

export type RoutinesApi = ReturnType<typeof createRoutinesApi>;
