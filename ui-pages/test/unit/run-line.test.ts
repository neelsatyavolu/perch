import { expect, test } from "bun:test";
import type { Routine } from "../../src/api";
import { runLine } from "../../src/pages/routines/RoutinesPage";

const now = new Date("2026-11-05T12:00:00.000Z");
const routine = (nextRun: string) => ({ enabled: true, nextRun, lastRun: null }) as unknown as Routine;

test("the next run reads as a phrase: a time soon is lowercased, a date keeps its capital", () => {
  expect(runLine(routine("2026-11-06T06:00:00.000Z"), now)).toBe("Hasn't run yet · next in 18 hr");
  expect(runLine(routine("2026-11-08T18:00:00.000Z"), now)).toBe("Hasn't run yet · next Nov 8");
});
