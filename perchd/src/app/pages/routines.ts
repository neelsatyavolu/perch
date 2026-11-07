/**
 * The Routines page over the routines API (src/routines). A daily schedule is a cron line, an
 * interval is the store's own interval schedule; routines that start on an event, and proposals
 * found from repeated chats, are not built yet.
 */

import type { Routine as PageRoutine, RoutineRun, Schedule as PageSchedule, Weekday } from "../../../../ui-pages/src/api";
import { parseCron, type Schedule } from "../../routines/schedule";
import type { RunRecord } from "../../routines/store";
import type { RoutineView } from "../../routines/api";
import { AppError } from "../runs";
import * as v from "../validate";
import { gone, notYet, ok, type Methods } from "./common";
import type { PagesDeps } from "./deps";

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PROPOSALS = "Perch can't suggest routines from your chats yet. Make one with New routine.";
const TRIGGERS = "Routines that start on an event aren't available yet. Pick a time of day or an interval.";
const pad = (n: number) => String(n).padStart(2, "0");

function toCron(time: string, days: readonly Weekday[]): Schedule {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const dow = days.length === 7 ? "*" : [...new Set(days)].map((d) => WEEKDAYS.indexOf(d)).sort().join(",");
  return { kind: "cron", expr: `${m} ${h} * * ${dow}` };
}

/** The page's schedule for a stored one. Cron lines it can't show exactly become their first daily time. */
export function pageSchedule(s: Schedule): PageSchedule {
  if (s.kind === "interval") return { kind: "interval", hours: s.hours };
  if (s.kind === "manual") return { kind: "daily", time: "09:00", days: [] };
  try {
    const spec = parseCron(s.expr);
    const days = spec.anyWeekday ? WEEKDAYS : spec.weekdays.map((d) => WEEKDAYS[d]!);
    return { kind: "daily", time: `${pad(spec.hours[0] ?? 0)}:${pad(spec.minutes[0] ?? 0)}`, days: WEEKDAYS.filter((d) => days.includes(d)) };
  } catch {
    return { kind: "daily", time: "09:00", days: [] };
  }
}

function scheduleInput(value: unknown): Schedule {
  const o = v.object(value, '"schedule"');
  if (o.kind === "daily") {
    v.onlyKeys(o, ["kind", "time", "days"]);
    const time = v.text(o.time, "time", 5).trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AppError("Use a 24-hour time, like 08:00");
    const days = v.list(o.days, "days", 7).map((d) => v.oneOf(d, "days", WEEKDAYS));
    if (days.length === 0) throw new AppError("Pick at least one day");
    return toCron(time, days);
  }
  if (o.kind === "interval") {
    v.onlyKeys(o, ["kind", "hours"]);
    if (!Number.isInteger(o.hours) || (o.hours as number) < 1 || (o.hours as number) > 168) throw new AppError("Pick between 1 and 168 hours");
    return { kind: "interval", hours: o.hours as number };
  }
  if (o.kind === "trigger") return notYet(TRIGGERS);
  throw new AppError('"schedule.kind" must be one of daily, interval, trigger');
}

function lastRun(runs: readonly RunRecord[]): RoutineRun | undefined {
  const r = runs.find((x) => x.status !== "skipped");
  if (!r) return undefined;
  const outcome = r.status === "ok" ? "ok" : r.status === "needs_approval" ? "waiting" : "failed";
  return { at: r.finishedAt, outcome };
}

export function routinesPages(deps: PagesDeps): Methods<
  "listRoutines" | "saveRoutine" | "setRoutineEnabled" | "deleteRoutine" | "runRoutine" | "findRoutineProposals" | "acceptProposal" | "dismissProposal"
> {
  const data = () => deps.data();

  async function view(r: RoutineView): Promise<PageRoutine> {
    const runs = ok(await (await data()).routinesApi.runs({ id: r.id, limit: 10 }));
    const last = lastRun(runs);
    return {
      id: r.id, title: r.name, prompt: r.task, schedule: pageSchedule(r.schedule), enabled: r.enabled,
      ...(last ? { lastRun: last } : {}), ...(r.nextRunAt ? { nextRun: r.nextRunAt } : {}),
    };
  }

  async function existing(id: unknown): Promise<RoutineView> {
    const result = await (await data()).routinesApi.get({ id: v.id(id, "id") });
    return result.ok ? result.data : gone("That routine was deleted");
  }

  return {
    async listRoutines() {
      return Promise.all(ok(await (await data()).routinesApi.list()).map(view));
    },
    async saveRoutine([input]) {
      const o = v.object(input, '"input"');
      v.onlyKeys(o, ["id", "title", "prompt", "schedule"]);
      const name = v.text(o.title, "title", 80).trim();
      if (!name) throw new AppError("Give it a name");
      const task = v.text(o.prompt, "prompt", 4000).trim();
      if (!task) throw new AppError("Say what the routine should do");
      const schedule = scheduleInput(o.schedule);
      const api = (await data()).routinesApi;
      if (o.id === undefined) return view(ok(await api.create({ name, task, schedule })));
      const { id } = await existing(o.id);
      return view(ok(await api.update({ id, name, task, schedule })));
    },
    async setRoutineEnabled([id, enabled]) {
      const r = await existing(id);
      return view(ok(await (await data()).routinesApi.setEnabled({ id: r.id, enabled: v.bool(enabled, "enabled") })));
    },
    async deleteRoutine([id]) {
      const r = await existing(id);
      ok(await (await data()).routinesApi.remove({ id: r.id }));
    },
    async runRoutine([id]) {
      const r = await existing(id);
      // A run can take minutes; the page follows it through the routine's last run.
      void (await data()).routinesApi.runNow({ id: r.id });
    },
    async findRoutineProposals() {
      return notYet(PROPOSALS);
    },
    async acceptProposal([id]) {
      v.id(id, "id");
      return notYet(PROPOSALS);
    },
    async dismissProposal([id]) {
      v.id(id, "id");
      return notYet(PROPOSALS);
    },
  };
}
