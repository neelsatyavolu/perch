import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkSchedule, describeSchedule, nextRun, parseCron, upcoming } from "../src/routines/schedule";

/** Runs nextRun/upcoming in a child process with its own time zone; TZ cannot change reliably mid-process. */
function inZone(tz: string, code: string): unknown {
  const script = `import { nextRun, upcoming } from ${JSON.stringify(join(import.meta.dir, "../src/routines/schedule.ts"))};\nconst fmt = (d) => d && \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, "0")}-\${String(d.getDate()).padStart(2, "0")} \${String(d.getHours()).padStart(2, "0")}:\${String(d.getMinutes()).padStart(2, "0")}\`;\nconsole.log(JSON.stringify(${code}));`;
  const proc = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, TZ: tz } });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}
/** Local wall-clock time in the test's time zone. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const local = (date: Date | null) => (date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : null);
const cron = (expr: string) => ({ kind: "cron" as const, expr });

test("parses fields with lists, ranges, steps, names and macros", () => {
  const spec = parseCron("*/15 8-10 * jan,mar mon-fri");
  expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
  expect([...spec.hours]).toEqual([8, 9, 10]);
  expect([...spec.months]).toEqual([1, 3]);
  expect([...spec.weekdays]).toEqual([1, 2, 3, 4, 5]);
  expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0]);
  expect(parseCron("@daily")).toEqual(parseCron("0 0 * * *"));
});

test("bad expressions get plain errors", () => {
  expect(() => parseCron("* * *")).toThrow("five fields");
  expect(() => parseCron("61 * * * *")).toThrow("minute");
  expect(() => parseCron("0 25 * * *")).toThrow("hour");
  expect(() => parseCron("0 0 0 * *")).toThrow("day of month");
  expect(() => parseCron("0 0 * * funday")).toThrow("day of week");
  expect(() => parseCron("*/0 * * * *")).toThrow("step");
  expect(() => parseCron("5-1 * * * *")).toThrow("range");
});

test("next run: every weekday at 8", () => {
  const s = cron("0 8 * * 1-5");
  expect(local(nextRun(s, at(2026, 11, 5, 7, 59)))).toBe("2026-11-05 08:00");
  expect(local(nextRun(s, at(2026, 11, 5, 8, 0)))).toBe("2026-11-06 08:00");
  expect(local(nextRun(s, at(2026, 11, 6, 9, 0)))).toBe("2026-11-09 08:00");
});

test("next run: month ends, leap days and day-of-month OR weekday", () => {
  expect(local(nextRun(cron("0 9 31 * *"), at(2026, 11, 5)))).toBe("2026-12-31 09:00");
  expect(local(nextRun(cron("0 0 29 2 *"), at(2026, 3, 1)))).toBe("2028-02-29 00:00");
  expect(local(nextRun(cron("0 12 1 * 1"), at(2026, 11, 5)))).toBe("2026-11-09 12:00");
  expect(nextRun(cron("0 0 30 2 *"), at(2026, 1, 1))).toBeNull();
  expect(nextRun({ kind: "manual" }, at(2026, 1, 1))).toBeNull();
});

test("next run across daylight saving changes", () => {
  const result = inZone(
    "America/Los_Angeles",
    `[
      upcoming({ kind: "cron", expr: "30 1 * * *" }, new Date(2026, 9, 31, 12), 2).map(fmt),
      fmt(nextRun({ kind: "cron", expr: "30 2 * * *" }, new Date(2026, 2, 7, 12))),
      fmt(nextRun({ kind: "cron", expr: "30 2 * * *" }, new Date(2026, 2, 8, 12))),
    ]`,
  );
  // 2026-11-01 01:00 happens twice in Los Angeles; the run happens once.
  // 2026-03-08 02:30 does not exist; the run moves to the first minute after the gap.
  expect(result).toEqual([["2026-11-01 01:30", "2026-11-02 01:30"], "2026-03-08 03:00", "2026-03-09 02:30"]);
});

test("schedules are described in plain words", () => {
  expect(describeSchedule(cron("0 8 * * 1-5"))).toBe("Every weekday at 08:00");
  expect(describeSchedule(cron("30 18 * * *"))).toBe("Every day at 18:30");
  expect(describeSchedule(cron("0 9 * * 1"))).toBe("Every Monday at 09:00");
  expect(describeSchedule(cron("0 10 * * 0,6"))).toBe("Every weekend day at 10:00");
  expect(describeSchedule(cron("0 7 1 * *"))).toBe("On day 1 of every month at 07:00");
  expect(describeSchedule(cron("15 * * * *"))).toBe("Every hour at :15");
  expect(describeSchedule(cron("*/30 * * * *"))).toBe("Every 30 minutes");
  expect(describeSchedule(cron("0 8 1-7 * 2"))).toBe("Schedule 0 8 1-7 * 2");
  expect(describeSchedule({ kind: "manual" })).toBe("Only when you run it");
});

test("checkSchedule refuses schedules that run more often than every 15 minutes or never", () => {
  expect(checkSchedule(cron("*/5 * * * *"), at(2026, 11, 5))).toBe("Routines can run at most every 15 minutes.");
  expect(checkSchedule(cron("0 0 30 2 *"), at(2026, 11, 5))).toBe("This schedule never runs.");
  expect(checkSchedule(cron("*/15 * * * *"), at(2026, 11, 5))).toBeNull();
  expect(checkSchedule(cron("nope"), at(2026, 11, 5))).toContain("five fields");
  expect(checkSchedule({ kind: "manual" }, at(2026, 11, 5))).toBeNull();
});
