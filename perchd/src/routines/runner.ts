/**
 * One routine run (spec 8). The routine's own permission mode applies. A run nobody is watching
 * (scheduled or catching up) declines everything that needs approval and lists it for the user.
 * Payments and password changes always need approval, so an unattended run never pays; in Ask and
 * Guard it also never sends, posts or deletes. Skip mode is the user's explicit choice to let
 * those run. A manual run asks the person who started it. Every run is audited as client
 * "routine:<id>" and kept as a chat.
 */

import type { AuditLog } from "../agent/audit";
import { runTask, type ApprovalRequest, type StepEvent, type TaskOptions } from "../agent/loop";
import type { Browser } from "../browser/browser";
import type { MemoryAccess } from "../memory/agent";
import { newId } from "../memory/page";
import type { Model } from "../models/types";
import type { Routine, RoutineStore, RunRecord, RunStatus, RunTrigger } from "./store";

export type RunnerDeps = {
  store: RoutineStore;
  audit: AuditLog;
  browser: () => Promise<Browser>;
  model: (routine: Routine) => Promise<Model>;
  /** Memory for a run; `attended` is false when nobody can approve, so every save is declined. */
  memory?: (routine: Routine, run: { attended: boolean }) => MemoryAccess | undefined;
  runTask?: (opts: TaskOptions) => AsyncIterable<StepEvent>;
  now?: () => Date;
  timeoutMs?: number;
};
export type RunOptions = { approve?: (request: ApprovalRequest) => Promise<boolean>; scheduledFor?: Date | null; signal?: AbortSignal };

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const TIMED_OUT = "The run took longer than its time limit and was stopped.";

export function unattendedNote(routine: Routine): string {
  return [
    `This is the saved routine "${routine.name}", running on its own while the user may be away.`,
    "Nobody can approve actions now: anything that needs approval will be declined. Do what you can without it, then finish with done and say what is left for the user.",
  ].join(" ");
}

export async function runRoutine(routine: Routine, trigger: RunTrigger, deps: RunnerDeps, opts: RunOptions = {}): Promise<RunRecord> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const attended = trigger === "manual" ? opts.approve : undefined;
  const declined: string[] = [];
  const approve = async (request: ApprovalRequest): Promise<boolean> => {
    if (attended) return attended(request);
    declined.push(request.summary);
    return false;
  };
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
  const task = attended ? routine.task : `${routine.task}\n\n${unattendedNote(routine)}`;
  const events: StepEvent[] = [];
  let status: RunStatus = "ok";
  let answer = "";
  let chatId: string | null = null;
  try {
    const [browser, model] = await Promise.all([deps.browser(), deps.model(routine)]);
    const run = deps.runTask ?? runTask;
    for await (const event of run({ model, browser, task, mode: routine.mode, approve, audit: deps.audit, client: `routine:${routine.id}`, signal, memory: deps.memory?.(routine, { attended: Boolean(attended) }) })) {
      if (event.type !== "text") events.push(event);
      if (event.type === "final") answer = event.text;
      if (event.type === "error") {
        status = "error";
        answer = event.message;
      }
    }
    if (timer.signal.aborted) [status, answer] = ["cancelled", TIMED_OUT];
    else if (opts.signal?.aborted) [status, answer] = ["cancelled", "The run was stopped."];
    else if (status === "ok" && declined.length) status = "needs_approval";
    chatId = newId();
  } catch (error) {
    status = "error";
    answer = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }
  const record: RunRecord = {
    id: newId(),
    routineId: routine.id,
    trigger,
    scheduledFor: opts.scheduledFor?.toISOString() ?? null,
    startedAt,
    finishedAt: now().toISOString(),
    status,
    answer,
    declined,
    chatId,
  };
  if (chatId) await deps.store.saveChat({ id: chatId, title: routine.name, createdAt: startedAt, routineId: routine.id, runId: record.id, task: routine.task, events });
  await deps.store.addRun(record);
  const latest = deps.store.get(routine.id);
  if (latest) await deps.store.save({ ...latest, lastRunAt: startedAt });
  return record;
}
