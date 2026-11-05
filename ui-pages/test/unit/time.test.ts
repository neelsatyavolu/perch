import { describe, expect, test } from "bun:test";
import { relativeTime } from "../../src/lib/time";

const now = new Date("2026-11-05T09:46:00.000Z");

describe("relativeTime", () => {
  test("recent times count minutes and hours", () => {
    expect(relativeTime("2026-11-05T09:45:40.000Z", now)).toBe("Just now");
    expect(relativeTime("2026-11-05T09:44:00.000Z", now)).toBe("2 min ago");
    expect(relativeTime("2026-11-05T06:46:00.000Z", now)).toBe("3 hr ago");
  });
  test("yesterday and older dates", () => {
    expect(relativeTime("2026-11-04T09:00:00.000Z", now, "UTC")).toBe("Yesterday");
    expect(relativeTime("2026-11-02T15:30:00.000Z", now, "UTC")).toBe("Nov 2");
    expect(relativeTime("2025-11-02T15:30:00.000Z", now, "UTC")).toBe("Nov 2, 2025");
  });
  test("future times say when", () => {
    expect(relativeTime("2026-11-05T11:46:00.000Z", now)).toBe("In 2 hr");
  });
  test("bad input stays readable", () => {
    expect(relativeTime("not a date", now)).toBe("");
  });
});
