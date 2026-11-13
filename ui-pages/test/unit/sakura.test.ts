import { describe, expect, test } from "bun:test";
import { cluster, lenticels, limbPath, petalD, type Pt } from "../../src/ui/sakura/art";
import { CLUSTERS, FLOWER_POINTS } from "../../src/ui/sakura/Branch";
import { petalCount, random, spawn, step, wind, type Petal } from "../../src/ui/sakura/engine";

const field = { width: 1440, height: 900 };

describe("Sakura petals", () => {
  test("the same seed gives the same fall, and values stay in range", () => {
    const a = random(7);
    const b = random(7);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  test("the number of petals follows the window, within 14 to 38", () => {
    expect(petalCount({ width: 400, height: 300 })).toBe(14);
    expect(petalCount(field)).toBe(31);
    expect(petalCount({ width: 5000, height: 3000 })).toBe(38);
  });

  test("a new petal starts above the top, or where it is told to", () => {
    const rand = random(3);
    for (let i = 0; i < 40; i++) {
      const p = spawn(rand, field);
      expect(p.y).toBeLessThan(0);
      expect(p.z).toBeGreaterThanOrEqual(0.35);
      expect(p.z).toBeLessThanOrEqual(1);
      expect(p.alpha).toBe(0);
    }
    const at = spawn(rand, field, { x: 300, y: 200 });
    expect(Math.abs(at.x - 300)).toBeLessThan(13);
    expect(Math.abs(at.y - 200)).toBeLessThan(9);
    expect(at.alpha).toBe(1);
  });

  test("petals fall, drift with the wind, and leave the field or come to rest", () => {
    const rand = random(11);
    const p = spawn(rand, field, { x: 200, y: 100 });
    let t = 0;
    let alive = true;
    for (let i = 0; i < 6000 && alive && p.rest === 0; i++) {
      t += 1 / 60;
      alive = step(p, 1 / 60, t, field, rand);
    }
    expect(p.y > 100 || !alive).toBe(true);
    expect(p.x).toBeGreaterThan(200);
  });

  test("the wind gusts but stays a breeze", () => {
    const samples = Array.from({ length: 2000 }, (_, i) => wind(i * 0.5));
    expect(Math.min(...samples)).toBeGreaterThan(-15);
    expect(Math.max(...samples)).toBeLessThan(90);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(30);
  });

  test("the pointer pushes nearby petals away", () => {
    const rand = random(5);
    const near = (): Petal => ({ ...spawn(rand, field, { x: 500, y: 500 }), x: 540, y: 500, vx: 0, vy: 0, z: 1 });
    const calm = near();
    const pushed = near();
    step(calm, 1 / 60, 0, field, random(1));
    step(pushed, 1 / 60, 0, field, random(1), { x: 500, y: 500, vx: 0, vy: 0 });
    expect(pushed.vx).toBeGreaterThan(calm.vx);
  });

  test("a resting petal lies flat, fades, then is done", () => {
    const p: Petal = { ...spawn(random(2), field), rest: 2, alpha: 1 };
    expect(step(p, 0.4, 0, field, random(2))).toBe(true);
    expect(p.alpha).toBe(1);
    expect(step(p, 1, 0, field, random(2))).toBe(true);
    expect(p.alpha).toBeLessThan(1);
    expect(step(p, 1, 0, field, random(2))).toBe(false);
  });
});

describe("Sakura branch", () => {
  const pts: Pt[] = [[0, 0], [50, 20], [100, 60]];

  test("a limb is one closed outline, the same every time", () => {
    const d = limbPath(pts, 12, 2, 4);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toBe(limbPath(pts, 12, 2, 4));
    expect(d).not.toContain("NaN");
  });

  test("petals are notched paths, and lenticels sit only where the bark is wide enough", () => {
    expect(petalD(10)).toMatch(/^M0 0C.*Z$/);
    const marks = lenticels(pts, 12, 1, 9);
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(m.every(Number.isFinite)).toBe(true);
  });

  test("a cluster has two to four flowers on stems from one spur, each with five petals", () => {
    for (let seed = 1; seed < 30; seed++) {
      const c = cluster([100, 100], 14, seed);
      expect(c.flowers.length).toBeGreaterThanOrEqual(2);
      expect(c.flowers.length).toBeLessThanOrEqual(4);
      for (const f of c.flowers) {
        expect(f.petals).toHaveLength(5);
        expect(f.from).toEqual([100, 100]);
        expect(f.tilt).toBeGreaterThan(0.6);
      }
    }
  });

  test("the branch is in full bloom, and every flower is a place petals can fall from", () => {
    const flowers = CLUSTERS.reduce((n, c) => n + c.flowers.length, 0);
    expect(flowers).toBeGreaterThanOrEqual(40);
    expect(FLOWER_POINTS).toHaveLength(flowers);
  });
});
