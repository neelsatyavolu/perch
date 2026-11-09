import { describe, expect, test } from "bun:test";
import { stepRate } from "../../src/media/video";

describe("stepRate", () => {
  test("moves a quarter step at a time", () => {
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1, -1)).toBe(0.75);
  });

  test("snaps an off-grid rate to the next grid value in the pressed direction", () => {
    expect(stepRate(1.1, 1)).toBe(1.25);
    expect(stepRate(1.1, -1)).toBe(1);
  });

  test("stays within 0.25 and 4", () => {
    expect(stepRate(0.25, -1)).toBe(0.25);
    expect(stepRate(4, 1)).toBe(4);
    expect(stepRate(16, 1)).toBe(4);
  });
});
