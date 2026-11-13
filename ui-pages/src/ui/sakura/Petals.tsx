/**
 * Draws Sakura mode's falling petals (engine.ts) on one canvas behind the page. It runs only while
 * a Sakura theme shows, pauses in a hidden tab, and with Reduce Motion draws one still frame. Some
 * petals start at the branch's blossoms; a click on the page's empty background sends a gust.
 */

import { useEffect, useRef } from "preact/hooks";
import { BRANCH_VIEW, FLOWER_POINTS } from "./Branch";
import { PETAL_TINTS, petalCount, petalPath, random, spawn, step, type Field, type Petal, type Pointer } from "./engine";

const SPRITE = 64;
/** Far petals are drawn from softer sprites: depth bands, sharpest last. */
const BLURS = [2.2, 1.1, 0];

function sakuraOn(): boolean {
  return document.documentElement.dataset.sakura !== undefined;
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** One petal image per tint and depth band: the outline filled base to tip, with a soft vein. */
function makeSprites(dark: boolean): HTMLCanvasElement[][] | null {
  const tints = PETAL_TINTS[dark ? "dark" : "light"];
  const sprites: HTMLCanvasElement[][] = [];
  for (const [base, mid, tip] of tints) {
    const row: HTMLCanvasElement[] = [];
    for (const blur of BLURS) {
      const c = document.createElement("canvas");
      c.width = c.height = SPRITE;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      const pad = 6;
      const s = SPRITE - pad * 2;
      ctx.translate(pad, pad);
      if (blur) ctx.filter = `blur(${blur}px)`;
      const fill = ctx.createLinearGradient(0, s, 0, 0);
      fill.addColorStop(0, base);
      fill.addColorStop(0.45, mid);
      fill.addColorStop(1, tip);
      ctx.beginPath();
      petalPath(ctx, s);
      ctx.fillStyle = fill;
      ctx.fill();
      if (!blur) {
        ctx.strokeStyle = "rgba(196, 92, 126, 0.18)";
        ctx.lineWidth = 1;
        ctx.stroke();
        // The faint vein down the middle that catches the light.
        ctx.beginPath();
        ctx.moveTo(s * 0.5, s * 0.96);
        ctx.quadraticCurveTo(s * 0.52, s * 0.55, s * 0.5, s * 0.2);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      row.push(c);
    }
    sprites.push(row);
  }
  return sprites;
}

function draw(ctx: CanvasRenderingContext2D, petals: readonly Petal[], sprites: HTMLCanvasElement[][], dpr: number, field: Field): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, field.width, field.height);
  // Far petals first, so near ones pass in front.
  for (const p of [...petals].sort((a, b) => a.z - b.z)) {
    const band = p.z < 0.55 ? 0 : p.z < 0.78 ? 1 : 2;
    const sprite = sprites[p.tint]![band]!;
    // A tumble is drawn as a squash across the petal; edge-on it nearly vanishes, as a real one does.
    const squash = 0.18 + 0.82 * Math.abs(Math.cos(p.flip));
    ctx.globalAlpha = p.alpha * (0.42 + 0.5 * p.z);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.scale(squash, 1);
    const size = p.size * (SPRITE / (SPRITE - 12));
    ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
  }
  ctx.globalAlpha = 1;
}

/** The branch's blossoms on screen, when the branch is showing. */
function blossomPoints(): { x: number; y: number }[] {
  const branch = document.querySelector<SVGSVGElement>(".sakura-branch");
  if (!branch) return [];
  const box = branch.getBoundingClientRect();
  if (box.width === 0) return [];
  const sx = box.width / BRANCH_VIEW.width;
  const sy = box.height / BRANCH_VIEW.height;
  return FLOWER_POINTS.map(([x, y]) => ({ x: box.left + x * sx, y: box.top + y * sy }));
}

export function Petals() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let frame = 0;
    let stop: (() => void) | null = null;

    const start = () => {
      stop?.();
      stop = null;
      if (!sakuraOn()) return;
      const ctx = canvas.getContext("2d");
      const sprites = makeSprites(document.documentElement.dataset.tone === "dark");
      if (!ctx || !sprites) return;
      const rand = random(0x5a4b);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let field: Field = { width: 0, height: 0 };
      const fit = () => {
        field = { width: window.innerWidth, height: window.innerHeight };
        canvas.width = Math.round(field.width * dpr);
        canvas.height = Math.round(field.height * dpr);
      };
      fit();
      const petals: Petal[] = Array.from({ length: petalCount(field) }, () => spawn(rand, field, undefined, true));
      const still = reducedMotion();
      if (still) {
        for (const p of petals) p.flip = rand() * 1.2;
        draw(ctx, petals, sprites, dpr, field);
      }
      let pointer: Pointer = null;
      let last = performance.now();
      let t = 0;
      const respawn = (i: number) => {
        // About a third start at a blossom on the branch, the rest above the top edge.
        const from = rand() < 0.35 ? blossomPoints() : [];
        petals[i] = spawn(rand, field, from.length ? from[Math.floor(rand() * from.length)] : undefined);
      };
      const tick = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        t += dt;
        petals.forEach((p, i) => {
          if (!step(p, dt, t, field, rand, pointer)) respawn(i);
        });
        if (pointer) pointer = { ...pointer, vx: pointer.vx * 0.9, vy: pointer.vy * 0.9 };
        draw(ctx, petals, sprites, dpr, field);
        frame = requestAnimationFrame(tick);
      };
      const onResize = () => {
        fit();
        if (still) draw(ctx, petals, sprites, dpr, field);
      };
      const onMove = (e: PointerEvent) => {
        const prev = pointer;
        pointer = { x: e.clientX, y: e.clientY, vx: prev ? (e.clientX - prev.x) * 30 : 0, vy: prev ? (e.clientY - prev.y) * 30 : 0 };
      };
      const onLeave = () => void (pointer = null);
      // A click on the page's own background (not a control) lets a gust of petals fly from there.
      const onClick = (e: MouseEvent) => {
        const target = e.target as Element | null;
        if (!target || target.closest("button, a, input, textarea, select, label, [role], .ccard, .rail, .box")) return;
        for (let n = 0; n < 9; n++) {
          const i = Math.floor(rand() * petals.length);
          const p = spawn(rand, field, { x: e.clientX, y: e.clientY });
          const angle = -Math.PI / 2 + (rand() - 0.5) * 2.4;
          p.vx = Math.cos(angle) * (90 + rand() * 120);
          p.vy = Math.sin(angle) * (90 + rand() * 120);
          p.z = 0.7 + rand() * 0.3;
          petals[i] = p;
        }
      };
      const onVisible = () => {
        cancelAnimationFrame(frame);
        if (!document.hidden && !still) {
          last = performance.now();
          frame = requestAnimationFrame(tick);
        }
      };
      window.addEventListener("resize", onResize);
      if (!still) {
        window.addEventListener("pointermove", onMove, { passive: true });
        document.addEventListener("pointerleave", onLeave);
        window.addEventListener("click", onClick);
        document.addEventListener("visibilitychange", onVisible);
        frame = requestAnimationFrame(tick);
      }
      stop = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerleave", onLeave);
        window.removeEventListener("click", onClick);
        document.removeEventListener("visibilitychange", onVisible);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      };
    };

    // Switching themes turns the petals on or off, and Sakura and Yozakura use different sprites;
    // anything else re-applying the same attributes leaves the fall as it is.
    const key = () => `${sakuraOn()}|${document.documentElement.dataset.tone ?? ""}`;
    let shown = key();
    start();
    const watch = new MutationObserver(() => {
      if (key() === shown) return;
      shown = key();
      start();
    });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-sakura", "data-tone"] });
    return () => {
      watch.disconnect();
      stop?.();
    };
  }, []);

  return <canvas ref={ref} class="sakura-only sakura-petals" aria-hidden="true" />;
}
