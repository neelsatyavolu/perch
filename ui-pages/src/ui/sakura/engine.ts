/**
 * Sakura mode's falling petals (DESIGN.md, Sakura mode), as a small simulation drawn on one canvas.
 *
 * Each petal has a depth: far petals are smaller, slower, fainter and softer, near ones larger and
 * crisper, so the fall reads as a space rather than a sheet. Petals tumble in 3D (a flip about their
 * own axis, drawn as a squash), ride a wind that gusts and eases, swirl away from the pointer, and
 * some come to rest along the bottom edge and fade before falling again. The step is pure, so tests
 * drive it without a canvas.
 */

export type Petal = {
  x: number;
  y: number;
  /** Depth, 0.35 (far) to 1 (near): scales size, speed, opacity and sharpness. */
  z: number;
  size: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  flip: number;
  flipSpeed: number;
  phase: number;
  /** Which of the petal sprites it uses (pale, blush, deep). */
  tint: number;
  /** Seconds left resting on the bottom edge; 0 while falling. */
  rest: number;
  /** 0 to 1, fading in after a respawn and out at the end of a rest. */
  alpha: number;
};

export type Field = { readonly width: number; readonly height: number };

/** A small deterministic random source, so a page looks the same on every load and tests can predict it. */
export function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100_000) / 100_000;
  };
}

/** About one petal per 42,000 square pixels, between 14 and 38. */
export function petalCount(field: Field): number {
  return Math.max(14, Math.min(38, Math.round((field.width * field.height) / 42_000)));
}

/** A new petal. `at` places it (a branch blossom, a click); otherwise it starts just above the top. */
export function spawn(rand: () => number, field: Field, at?: { x: number; y: number }, scatter = false): Petal {
  const z = 0.35 + rand() * 0.65;
  return {
    x: at ? at.x + (rand() - 0.5) * 24 : rand() * field.width,
    y: at ? at.y + (rand() - 0.5) * 16 : scatter ? rand() * field.height : -20 - rand() * field.height * 0.25,
    z,
    size: (7 + rand() * 7) * (0.55 + z * 0.65),
    vx: (rand() - 0.5) * 12,
    vy: 0,
    rot: rand() * Math.PI * 2,
    spin: (rand() - 0.5) * 1.6,
    flip: rand() * Math.PI * 2,
    flipSpeed: 1.2 + rand() * 2.6,
    phase: rand() * Math.PI * 2,
    tint: Math.floor(rand() * 3),
    rest: 0,
    alpha: at || scatter ? 1 : 0,
  };
}

/** The wind across the page at time `t` (seconds): a steady drift with slow gusts, in px/s. */
export function wind(t: number): number {
  return 14 + Math.sin(t * 0.21) * 16 + Math.sin(t * 0.53 + 1.3) * 9 + Math.max(0, Math.sin(t * 0.09)) ** 6 * 46;
}

export type Pointer = { x: number; y: number; vx: number; vy: number } | null;

const GRAVITY = 26;
const POINTER_REACH = 130;

/**
 * Moves one petal on by `dt` seconds. Returns false when it has left the field or finished resting,
 * so the caller respawns it.
 */
export function step(p: Petal, dt: number, t: number, field: Field, rand: () => number, pointer: Pointer = null): boolean {
  if (p.rest > 0) {
    p.rest -= dt;
    if (p.rest < 1.5) p.alpha = Math.max(0, p.rest / 1.5);
    return p.rest > 0;
  }
  if (p.alpha < 1) p.alpha = Math.min(1, p.alpha + dt * 0.8);
  // Falling: gravity against drag, faster for near petals; a flat-on petal (cos(flip) near 1)
  // catches more air than one edge-on, which is what makes real petals flutter.
  const face = Math.abs(Math.cos(p.flip));
  const terminal = (16 + 30 * p.z) * (1.15 - 0.45 * face);
  p.vy += (GRAVITY * p.z - (p.vy / terminal) * GRAVITY) * dt;
  const sway = Math.sin(t * 1.3 + p.phase) * 18 * (0.4 + face);
  const target = wind(t) * (0.45 + p.z * 0.75) + sway;
  p.vx += (target - p.vx) * Math.min(1, dt * 1.6);
  if (pointer) {
    const dx = p.x - pointer.x;
    const dy = p.y - pointer.y;
    const d = Math.hypot(dx, dy);
    if (d < POINTER_REACH && d > 0.5) {
      // Air pushed by the pointer: away from it, and along the way it is moving.
      const push = (1 - d / POINTER_REACH) ** 2;
      p.vx += ((dx / d) * 220 + pointer.vx * 0.5) * push * dt * p.z;
      p.vy += ((dy / d) * 160 + pointer.vy * 0.5) * push * dt * p.z;
      p.spin += (pointer.vx > 0 ? 1 : -1) * push * dt * 6;
    }
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.rot += p.spin * dt;
  p.flip += p.flipSpeed * dt * (0.6 + face * 0.8);
  if (p.y > field.height - p.size * 0.4 && p.z > 0.55 && rand() < 0.4) {
    // Some near petals settle on the bottom edge for a while, lying flat.
    p.y = field.height - p.size * 0.4;
    p.rest = 5 + rand() * 7;
    p.flip = 0;
    return true;
  }
  return p.y < field.height + 30 && p.x > -60 && p.x < field.width + 60;
}

/** A petal pointing up, 1 unit square, notched at its tip: the outline every sprite fills. */
export function petalPath(ctx: CanvasRenderingContext2D | Path2D, s: number): void {
  ctx.moveTo(0.5 * s, 1 * s);
  ctx.bezierCurveTo(0.14 * s, 0.86 * s, -0.02 * s, 0.46 * s, 0.11 * s, 0.13 * s);
  ctx.bezierCurveTo(0.2 * s, 0.01 * s, 0.38 * s, -0.01 * s, 0.5 * s, 0.13 * s);
  ctx.bezierCurveTo(0.62 * s, -0.01 * s, 0.8 * s, 0.01 * s, 0.89 * s, 0.13 * s);
  ctx.bezierCurveTo(1.02 * s, 0.46 * s, 0.86 * s, 0.86 * s, 0.5 * s, 1 * s);
  ctx.closePath();
}

/** The three petal colours, base (where it joined the flower) to tip, for light and dark themes. */
export const PETAL_TINTS: Readonly<Record<"light" | "dark", readonly (readonly [string, string, string])[]>> = {
  light: [
    ["#F2B8C8", "#FBDCE4", "#FFF6F8"],
    ["#E98FAA", "#F6BDCD", "#FDE8EE"],
    ["#D9708F", "#EFA2B8", "#FAD3DE"],
  ],
  dark: [
    ["#E9A9BC", "#F8D2DD", "#FFF2F5"],
    ["#E28AA6", "#F3B8C9", "#FDE4EB"],
    ["#CF6F8E", "#EA9FB5", "#F8CEDA"],
  ],
};
