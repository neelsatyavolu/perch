/**
 * Routine schedules: five-field cron (minute hour day-of-month month day-of-week) in the Mac's
 * local time, or manual. Lists, ranges, steps, month and day names and @hourly/@daily/@weekly/
 * @monthly work. When both day fields are set, either may match, as in Vixie cron. A time that a
 * daylight-saving change skips runs at the first minute after the gap; a repeated hour runs once.
 * An interval schedule runs every so many hours (1 to 168), counted from the last run.
 */

export type Schedule = { kind: "manual" } | { kind: "cron"; expr: string } | { kind: "interval"; hours: number };
export type CronSpec = {
  minutes: readonly number[];
  hours: readonly number[];
  days: readonly number[];
  months: readonly number[];
  weekdays: readonly number[];
  anyDay: boolean;
  anyWeekday: boolean;
};

const MACROS: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SEARCH_DAYS = 366 * 5;
const MIN_GAP_MS = 15 * 60_000;
export const MAX_INTERVAL_HOURS = 168;

type Field = { name: string; min: number; max: number; names?: string[]; nameBase?: number };
const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of week", min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

function value(text: string, field: Field): number {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
  const n = named >= 0 ? named + (field.nameBase ?? 0) : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < field.min || n > field.max) throw new Error(`"${text}" is not a valid ${field.name}`);
  return n;
}

function parseField(text: string, field: Field): number[] {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`the step in "${part}" must be a whole number above 0`);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [field.min, field.name === "day of week" ? 6 : field.max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-") as [string, string];
      [lo, hi] = [value(a, field), value(b, field)];
      if (lo > hi) throw new Error(`the range "${range}" goes backwards`);
    } else {
      lo = value(range, field);
      hi = stepText === undefined ? lo : field.max;
    }
    for (let n = lo; n <= hi; n += step) out.add(field.name === "day of week" && n === 7 ? 0 : n);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSpec {
  const text = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule needs five fields: minute hour day-of-month month day-of-week, like 0 8 * * 1-5.");
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [number[], number[], number[], number[], number[]];
  return { minutes, hours, days, months, weekdays, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const dom = spec.days.includes(date.getDate());
  const dow = spec.weekdays.includes(date.getDay());
  if (spec.anyDay && spec.anyWeekday) return true;
  if (spec.anyDay) return dow;
  if (spec.anyWeekday) return dom;
  return dom || dow;
}

function nextFromSpec(spec: CronSpec, after: Date): Date | null {
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (!spec.months.includes(day.getMonth() + 1) || !dayMatches(spec, day)) continue;
    for (const h of spec.hours) {
      for (const m of spec.minutes) {
        let candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        // A time skipped by a daylight-saving change runs at the first minute after the gap.
        if (candidate.getHours() !== h) candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h + 1, 0);
        if (candidate.getTime() > after.getTime()) return candidate;
      }
    }
  }
  return null;
}

/** The first run strictly after `after`, or null for manual schedules and ones that never run. */
export function nextRun(schedule: Schedule, after: Date): Date | null {
  if (schedule.kind === "manual") return null;
  if (schedule.kind === "interval") {
    if (!Number.isInteger(schedule.hours) || schedule.hours < 1 || schedule.hours > MAX_INTERVAL_HOURS) throw new Error(`Pick between 1 and ${MAX_INTERVAL_HOURS} hours.`);
    return new Date(after.getTime() + schedule.hours * 3_600_000);
  }
  return nextFromSpec(parseCron(schedule.expr), after);
}

export function upcoming(schedule: Schedule, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextRun(schedule, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** A plain error for a schedule that cannot be saved, or null when it is fine. */
export function checkSchedule(schedule: Schedule, now: Date): string | null {
  if (schedule.kind === "manual") return null;
  let runs: Date[];
  try {
    runs = upcoming(schedule, now, 30);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!runs.length) return "This schedule never runs.";
  for (let i = 1; i < runs.length; i++) if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_GAP_MS) return "Routines can run at most every 15 minutes.";
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "manual") return "Only when you run it";
  if (schedule.kind === "interval") return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  const expr = schedule.expr.trim();
  let spec: CronSpec;
  try {
    spec = parseCron(expr);
  } catch {
    return `Schedule ${expr}`;
  }
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(MACROS[expr] ?? expr);
  if (every) return `Every ${every[1]} minutes`;
  const allMonths = spec.months.length === 12;
  const oneTime = spec.minutes.length === 1 && spec.hours.length === 1;
  const time = oneTime ? `${pad(spec.hours[0]!)}:${pad(spec.minutes[0]!)}` : "";
  if (spec.minutes.length === 1 && spec.hours.length === 24 && spec.anyDay && spec.anyWeekday && allMonths) return `Every hour at :${pad(spec.minutes[0]!)}`;
  if (!oneTime || !allMonths) return `Schedule ${expr}`;
  if (spec.anyDay && spec.anyWeekday) return `Every day at ${time}`;
  if (spec.anyDay) {
    const days = spec.weekdays.join(",");
    if (days === "1,2,3,4,5") return `Every weekday at ${time}`;
    if (days === "0,6") return `Every weekend day at ${time}`;
    if (spec.weekdays.length === 1) return `Every ${DAY_NAMES[spec.weekdays[0]!]} at ${time}`;
  }
  if (spec.anyWeekday && spec.days.length === 1) return `On day ${spec.days[0]} of every month at ${time}`;
  return `Schedule ${expr}`;
}
