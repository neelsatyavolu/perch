// Writes the Sakura and Yozakura app icons (branding/sakura/*.svg): the songbird of perch-mark.svg
// on a blush (or night) tile, perched on a cherry branch in bloom, with a blossom on its head.
// Run: bun branding/sakura/make-sakura-marks.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fmt = (n: number) => n.toFixed(1);
function petalD(r: number): string {
  const w = r * 0.56;
  return [
    `M0 0`,
    `C${fmt(-w * 0.55)} ${fmt(-r * 0.12)} ${fmt(-w * 1.02)} ${fmt(-r * 0.55)} ${fmt(-w * 0.78)} ${fmt(-r * 0.88)}`,
    `C${fmt(-w * 0.6)} ${fmt(-r * 1.04)} ${fmt(-w * 0.22)} ${fmt(-r * 1.04)} 0 ${fmt(-r * 0.9)}`,
    `C${fmt(w * 0.22)} ${fmt(-r * 1.04)} ${fmt(w * 0.6)} ${fmt(-r * 1.04)} ${fmt(w * 0.78)} ${fmt(-r * 0.88)}`,
    `C${fmt(w * 1.02)} ${fmt(-r * 0.55)} ${fmt(w * 0.55)} ${fmt(-r * 0.12)} 0 0Z`,
  ].join("");
}

type Palette = { tile: string; edge: string; bird: string; wood: string; base: string; tip: string; eye: string; anther: string };
const LIGHT: Palette = { tile: "#FAF2F4", edge: "#2A1A1F", bird: "#2A1A1F", wood: "#6B3F46", base: "#C2355F", tip: "#F6B6C8", eye: "#8E1F44", anther: "#F2C14E" };
const NIGHT: Palette = { tile: "#150F12", edge: "#F8E9ED", bird: "#F8E9ED", wood: "#A0707A", base: "#E07A9A", tip: "#FFE4EB", eye: "#A72B53", anther: "#F2C14E" };

function blossom(id: string, x: number, y: number, r: number, turn: number, p: Palette): string {
  const petals = [0, 72, 144, 216, 288].map((d) => `<path d="${petalD(r)}" fill="url(#${id})" transform="rotate(${d + turn})"/>`).join("");
  const anthers = [0, 72, 144, 216, 288]
    .map((d) => {
      const a = ((d + 36 + turn) * Math.PI) / 180;
      return `<circle cx="${fmt(Math.sin(a) * r * 0.36)}" cy="${fmt(-Math.cos(a) * r * 0.36)}" r="${fmt(r * 0.06)}" fill="${p.anther}"/>`;
    })
    .join("");
  return `<g transform="translate(${x} ${y})">${petals}<circle r="${fmt(r * 0.22)}" fill="${p.eye}"/>${anthers}</g>`;
}

function mark(p: Palette, note: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- ${note} -->
  <defs><linearGradient id="bl" x1="0.5" y1="1" x2="0.5" y2="0"><stop offset="0" stop-color="${p.base}"/><stop offset="1" stop-color="${p.tip}"/></linearGradient></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="${p.tile}"/>
  <rect x="102" y="102" width="820" height="820" rx="183" fill="none" stroke="${p.edge}" stroke-opacity="0.08" stroke-width="4"/>
  <g transform="translate(512 512) scale(.8) translate(-512 -512)">
    <path d="M169 729 L855 729" stroke="${p.wood}" stroke-width="42" stroke-linecap="round"/>
    <path d="M300 729 Q330 790 392 800" stroke="${p.wood}" stroke-width="20" stroke-linecap="round" fill="none"/>
    <path d="M232 757L407.4 378.7A192.5 192.5 0 1 1 633.6 645ZM638 403.5a22.75 22.75 0 1 0 45.5 0a22.75 22.75 0 1 0-45.5 0ZM757 382.5L848 426.3L753.5 466.5ZM548.8 645h21v72h-21ZM601.3 634.5h21v82.5h-21Z" fill="${p.bird}"/>
    ${blossom("bl", 588, 262, 74, 8, p)}
    ${blossom("bl", 790, 712, 62, -14, p)}
    ${blossom("bl", 398, 806, 50, 20, p)}
  </g>
</svg>
`;
}

const dir = import.meta.dir;
writeFileSync(join(dir, "perch-mark-sakura.svg"), mark(LIGHT, "Perch in Sakura mode: the songbird on a blush tile, on a cherry branch in bloom, a blossom on its head."));
writeFileSync(join(dir, "perch-mark-yozakura.svg"), mark(NIGHT, "Perch in Yozakura (Sakura at night): the same on a night tile, the bird in pale blossom-white."));
