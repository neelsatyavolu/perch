import { describe, expect, test } from "bun:test";
import { planTiles } from "../../src/shot/tiles";

describe("planTiles", () => {
  test("covers the page in viewport-high strips, the last one shorter", () => {
    expect(planTiles({ pageHeight: 2500, viewportHeight: 1000, dpr: 2 })).toEqual({
      height: 2500,
      truncated: false,
      tiles: [
        { y: 0, height: 1000 },
        { y: 1000, height: 1000 },
        { y: 2000, height: 500 },
      ],
    });
  });

  test("a page shorter than the viewport is one tile", () => {
    expect(planTiles({ pageHeight: 600, viewportHeight: 900, dpr: 1 }).tiles).toEqual([{ y: 0, height: 600 }]);
  });

  test("very tall pages stop at the canvas limit and say so", () => {
    const plan = planTiles({ pageHeight: 100_000, viewportHeight: 1000, dpr: 2, maxDevicePixels: 32_000 });
    expect(plan.height).toBe(16_000);
    expect(plan.truncated).toBe(true);
    expect(plan.tiles.at(-1)).toEqual({ y: 15_000, height: 1000 });
  });

  test("rejects nonsense sizes", () => {
    expect(() => planTiles({ pageHeight: 0, viewportHeight: 900, dpr: 1 })).toThrow();
    expect(() => planTiles({ pageHeight: 900, viewportHeight: Number.NaN, dpr: 1 })).toThrow();
  });
});
