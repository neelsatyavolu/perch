/**
 * Geometry for Sakura mode's branch (DESIGN.md, Sakura mode): tapered limbs as filled outlines,
 * and blossoms, buds and leaves placed along them. Pure functions of fixed points and a seed, so the
 * branch is the same on every load and the shapes can be tested.
 */

import { random } from "./engine";

export type Pt = readonly [number, number];

/** A point on a Catmull-Rom curve through `pts` at `t` (0 to 1 over the whole curve). */
function catmull(pts: readonly Pt[], t: number): Pt {
  const n = pts.length - 1;
  const f = Math.min(n - 1e-9, Math.max(0, t * n));
  const i = Math.floor(f);
  const u = f - i;
  const p0 = pts[Math.max(0, i - 1)]!;
  const p1 = pts[i]!;
  const p2 = pts[i + 1]!;
  const p3 = pts[Math.min(n, i + 2)]!;
  const c = (a: number, b: number, c2: number, d: number) =>
    0.5 * (2 * b + (-a + c2) * u + (2 * a - 5 * b + 4 * c2 - d) * u * u + (-a + 3 * b - 3 * c2 + d) * u * u * u);
  return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
}

const fmt = (n: number) => Math.round(n * 10) / 10;

/**
 * A limb as a filled outline: the curve through `pts`, `w0` wide at its start tapering to `w1`, with
 * a slight knobbly wobble so it reads as bark rather than a pipe.
 */
export function limbPath(pts: readonly Pt[], w0: number, w1: number, seed: number): string {
  const rand = random(seed);
  const steps = 28;
  const left: Pt[] = [];
  const right: Pt[] = [];
  const wobble = Array.from({ length: steps + 1 }, () => 0.85 + rand() * 0.3);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const [x, y] = catmull(pts, t);
    const [ax, ay] = catmull(pts, Math.max(0, t - 0.01));
    const [bx, by] = catmull(pts, Math.min(1, t + 0.01));
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const w = ((w0 + (w1 - w0) * t ** 0.8) / 2) * wobble[s]!;
    left.push([x + nx * w, y + ny * w]);
    right.push([x - nx * w, y - ny * w]);
  }
  const all = [...left, ...right.reverse()];
  return `M${all.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}Z`;
}

/** The centre line of a limb, for placing things along it. */
export function along(pts: readonly Pt[], t: number): Pt {
  return catmull(pts, t);
}

/** One cherry petal pointing up from (0, 0), `r` long: broad, rounded and notched at the tip. */
export function petalD(r: number): string {
  const w = r * 0.56;
  return [
    `M0 0`,
    `C${fmt(-w * 0.55)} ${fmt(-r * 0.12)} ${fmt(-w * 1.02)} ${fmt(-r * 0.55)} ${fmt(-w * 0.78)} ${fmt(-r * 0.88)}`,
    `C${fmt(-w * 0.6)} ${fmt(-r * 1.04)} ${fmt(-w * 0.22)} ${fmt(-r * 1.04)} 0 ${fmt(-r * 0.9)}`,
    `C${fmt(w * 0.22)} ${fmt(-r * 1.04)} ${fmt(w * 0.6)} ${fmt(-r * 1.04)} ${fmt(w * 0.78)} ${fmt(-r * 0.88)}`,
    `C${fmt(w * 1.02)} ${fmt(-r * 0.55)} ${fmt(w * 0.55)} ${fmt(-r * 0.12)} 0 0Z`,
  ].join("");
}

export type Flower = {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Rotation of the whole flower, degrees. */
  readonly rot: number;
  /** How far the flower faces away: 1 face-on, down to 0.55 seen at an angle (a vertical squash). */
  readonly tilt: number;
  /** Per-petal angle jitter and length, for five petals that never look stamped. */
  readonly petals: readonly { readonly a: number; readonly k: number }[];
  /** Where its stem leaves the twig. */
  readonly from: Pt;
};

export type Bud = { readonly x: number; readonly y: number; readonly r: number; readonly rot: number; readonly from: Pt };
export type Leaf = { readonly x: number; readonly y: number; readonly r: number; readonly rot: number };

export type Cluster = { readonly at: Pt; readonly flowers: readonly Flower[]; readonly buds: readonly Bud[]; readonly leaves: readonly Leaf[] };

/**
 * A cluster as on a real cherry: two to four flowers hanging on thin stems from one spur, often a
 * bud or two, sometimes a young bronze leaf.
 */
export function cluster(at: Pt, size: number, seed: number, droop = 1): Cluster {
  const rand = random(seed);
  const n = 2 + Math.floor(rand() * 3);
  const flowers: Flower[] = Array.from({ length: n }, (_, i) => {
    // Stems fan out downward (or outward, for a cluster on the top of a limb).
    const angle = (Math.PI / 2) * droop + (i - (n - 1) / 2) * 0.62 + (rand() - 0.5) * 0.35;
    const reach = size * (1.1 + rand() * 0.9);
    const r = size * (0.86 + rand() * 0.28);
    return {
      x: at[0] + Math.cos(angle) * reach,
      y: at[1] + Math.sin(angle) * reach,
      r,
      rot: rand() * 72,
      tilt: 0.62 + rand() * 0.38,
      petals: Array.from({ length: 5 }, () => ({ a: (rand() - 0.5) * 10, k: 0.92 + rand() * 0.14 })),
      from: at,
    };
  });
  const buds: Bud[] = rand() < 0.75
    ? Array.from({ length: 1 + Math.floor(rand() * 2) }, () => {
        const angle = (Math.PI / 2) * droop + (rand() - 0.5) * 2.2;
        const reach = size * (0.8 + rand() * 0.6);
        return { x: at[0] + Math.cos(angle) * reach, y: at[1] + Math.sin(angle) * reach, r: size * (0.28 + rand() * 0.1), rot: (angle * 180) / Math.PI - 90, from: at };
      })
    : [];
  const leaves: Leaf[] = rand() < 0.4 ? [{ x: at[0] + (rand() - 0.5) * size, y: at[1] - size * 0.2, r: size * 0.75, rot: -120 + rand() * 60 }] : [];
  return { at, flowers, buds, leaves };
}

/** A young cherry leaf pointing up from (0, 0), `r` long: a pointed oval. */
export function leafD(r: number): string {
  const w = r * 0.36;
  return `M0 0C${fmt(-w)} ${fmt(-r * 0.25)} ${fmt(-w * 0.9)} ${fmt(-r * 0.75)} 0 ${fmt(-r)}C${fmt(w * 0.9)} ${fmt(-r * 0.75)} ${fmt(w)} ${fmt(-r * 0.25)} 0 0Z`;
}

/**
 * Cherry bark's lenticels: short marks across the limb (around its girth), spaced along it, as
 * line segments [x1, y1, x2, y2] in the limb's coordinates.
 */
export function lenticels(pts: readonly Pt[], w0: number, w1: number, seed: number): (readonly [number, number, number, number])[] {
  const rand = random(seed);
  const out: (readonly [number, number, number, number])[] = [];
  for (let t = 0.03; t < 0.92; t += 0.035 + rand() * 0.05) {
    const [x, y] = catmull(pts, t);
    const [bx, by] = catmull(pts, Math.min(1, t + 0.01));
    const len = Math.hypot(bx - x, by - y) || 1;
    const nx = -(by - y) / len;
    const ny = (bx - x) / len;
    const w = (w0 + (w1 - w0) * t ** 0.8) / 2;
    if (w < 2.2) continue;
    // Around the girth means along the limb's normal: a short band, off-centre on the bark.
    const off = (rand() - 0.5) * w * 0.7;
    const half = w * (0.2 + rand() * 0.25);
    out.push([x + nx * (off - half), y + ny * (off - half), x + nx * (off + half), y + ny * (off + half)]);
  }
  return out;
}

/** The limb's upper edge, a little inside it: where light catches the bark. */
export function highlightPath(pts: readonly Pt[], w0: number, w1: number): string {
  const steps = 20;
  const out: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const [x, y] = catmull(pts, t);
    const [bx, by] = catmull(pts, Math.min(1, t + 0.01));
    const [ax, ay] = catmull(pts, Math.max(0, t - 0.01));
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let nx = -(by - ay) / len;
    let ny = (bx - ax) / len;
    if (ny > 0) [nx, ny] = [-nx, -ny];
    const w = ((w0 + (w1 - w0) * t ** 0.8) / 2) * 0.55;
    out.push(`${fmt(x + nx * w)} ${fmt(y + ny * w)}`);
  }
  return `M${out.join("L")}`;
}
