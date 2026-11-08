/**
 * One entry point that opens a profile's memory and routines and wires them together for the
 * daemon: the stores, the scheduler with the routine runner, nightly dreaming, per-chat memory,
 * and the typed APIs for the Memory and Routines pages.
 *
 *   <dataDir>/memory/    encrypted memory pages, settings and change log
 *   <dataDir>/routines/  encrypted routines, runs and run chats
 */

import { join } from "node:path";
import type { AuditLog } from "../agent/audit";
import type { StepEvent, TaskOptions } from "../agent/loop";
import type { Browser } from "../browser/browser";
import { chatMemory } from "../memory/agent";
import { createMemoryApi } from "../memory/api";
import { dream, type DreamReport } from "../memory/dream";
import { macKeychain, type KeyStore } from "../memory/keychain";
import { hasRecords } from "../memory/records";
import type { Embedder } from "../memory/search";
import type { SetupInputs } from "../memory/setup";
import { memoryAllowed, type PolicyView } from "../policy/policy";
import { MemoryStore } from "../memory/store";
import type { Model } from "../models/types";
import { createRoutinesApi } from "./api";
import { runRoutine, type RunnerDeps } from "./runner";
import { Scheduler } from "./scheduler";
import { RoutineStore, type Routine } from "./store";

export type PerchDataOptions = {
  dataDir: string;
  profile: string;
  keys?: KeyStore;
  /** The profile's task models (spec 7.3): fast for extraction and dreaming, and the model a routine uses. */
  models: { fast: () => Promise<Model>; forRoutine: (routine: Routine) => Promise<Model> };
  browser: () => Promise<Browser>;
  audit: AuditLog;
  setupInputs: () => SetupInputs;
  embedder?: Embedder;
  runTask?: (opts: TaskOptions) => AsyncIterable<StepEvent>;
  now?: () => Date;
  /** Company policy: the agent and memory on or off, the mode cap and site rules. */
  policy?: PolicyView;
};

/** Local hour after which the day's dreaming pass may run. */
const DREAM_HOUR = 3;
const DREAM_CHECK_MS = 30 * 60_000;

export async function openPerchData(opts: PerchDataOptions) {
  const now = opts.now ?? (() => new Date());
  const keys = opts.keys ?? macKeychain();
  const memoryDir = join(opts.dataDir, "memory");
  const routinesDir = join(opts.dataDir, "routines");
  // Both folders share the profile key: a new key is made only when neither holds any data.
  const createKey = !(await hasRecords(memoryDir)) && !(await hasRecords(routinesDir));
  const memory = await MemoryStore.open({ dir: memoryDir, keys, profile: opts.profile, now, embedder: opts.embedder, createKey });
  const routines = await RoutineStore.open(routinesDir, keys, opts.profile, { createKey: false });
  const memoryOn = () => !opts.policy || memoryAllowed(opts.policy.current());
  const runner: RunnerDeps = {
    store: routines,
    audit: opts.audit,
    browser: opts.browser,
    model: opts.models.forRoutine,
    memory: (_routine, run) => (memoryOn() ? chatMemory(memory, { unattended: !run.attended }) : undefined),
    runTask: opts.runTask,
    now,
    ...(opts.policy ? { policy: opts.policy } : {}),
  };
  const scheduler = new Scheduler({ store: routines, now, run: (routine, trigger, scheduledFor) => runRoutine(routine, trigger, runner, { scheduledFor }) });
  let lastDream = "";
  let dreamTimer: ReturnType<typeof setInterval> | null = null;

  /** Runs dreaming once a day after 03:00 local time, unless memory is paused or off, or dreaming is. */
  async function dreamIfDue(): Promise<DreamReport | null> {
    const t = now();
    const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    const settings = memory.settings();
    if (!memoryOn() || lastDream === today || t.getHours() < DREAM_HOUR || settings.paused || !settings.extraction || !settings.dreaming) return null;
    lastDream = today;
    const model = await opts.models.fast().catch(() => undefined);
    return dream({ store: memory, model, now: t });
  }

  return {
    memory,
    routines,
    scheduler,
    dreamIfDue,
    memoryApi: createMemoryApi({ store: memory, model: opts.models.fast, setupInputs: opts.setupInputs, now }),
    /** The fast role's model, for small calls such as grouping routine proposals. */
    fastModel: opts.models.fast,
    routinesApi: createRoutinesApi({
      store: routines,
      scheduler,
      now,
      runAttended: (approve) => (routine, trigger, scheduledFor) => runRoutine(routine, trigger, runner, { approve, scheduledFor }),
    }),
    /** Memory for a sidebar chat; undefined for incognito. Extraction uses the fast model. */
    chatMemory: async (chat: { incognito?: boolean } = {}) => !memoryOn() ? undefined : chatMemory(memory, { incognito: chat.incognito, extractWith: chat.incognito ? undefined : await opts.models.fast().catch(() => undefined) }),
    start(): void {
      scheduler.start();
      dreamTimer ??= setInterval(() => void dreamIfDue().catch(() => null), DREAM_CHECK_MS);
    },
    stop(): void {
      scheduler.stop();
      if (dreamTimer) clearInterval(dreamTimer);
      dreamTimer = null;
      memory.close();
    },
  };
}

export type PerchData = Awaited<ReturnType<typeof openPerchData>>;
