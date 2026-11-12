import { expect, test } from "bun:test";
import { lastUsedLine, profileLine } from "../../src/pages/import/ImportSteps";

test("a browser's profile line never repeats the browser's own name", () => {
  expect(profileLine("Safari", [{ name: "Safari" }])).toBe("1 profile");
  expect(profileLine("Aside", [{ name: "Personal" }])).toBe("Personal");
  expect(profileLine("Chrome", [{ name: "Work" }, { name: "Home" }])).toBe("2 profiles");
});

test("lastUsedLine: today, yesterday, days, then the month", () => {
  const now = new Date(2026, 10, 12, 15).getTime();
  expect(lastUsedLine(new Date(2026, 10, 12, 1).getTime(), now)).toBe("Used today");
  expect(lastUsedLine(new Date(2026, 10, 11, 23).getTime(), now)).toBe("Used yesterday");
  expect(lastUsedLine(new Date(2026, 10, 2).getTime(), now)).toBe("Used 10 days ago");
  expect(lastUsedLine(new Date(2026, 2, 4).getTime(), now)).toBe("Used in March");
  expect(lastUsedLine(new Date(2025, 2, 4).getTime(), now)).toBe("Used in March 2025");
});
