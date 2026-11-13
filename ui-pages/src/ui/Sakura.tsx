/**
 * Sakura mode's decorations (DESIGN.md, Sakura mode): drifting petals, a blossoming branch, and
 * the blossom the Perch mark's dot turns into. Everything here renders always but shows only
 * under `:root[data-sakura]` (styles/sakura.css), so other themes pay nothing and switching
 * themes needs no re-render. All of it is decorative and hidden from assistive tech.
 */

import { useId } from "preact/hooks";
import { petalD } from "./sakura/art";

/** One cherry petal, 16 units tall, notched at its tip (the sidebar's petal burst draws the same). */
export const PETAL_PATH = "M8 16C0.6 13 -0.8 5.2 3.4 0.9C5 0.4 6.6 1.3 8 3.3C9.4 1.3 11 0.4 12.6 0.9C16.8 5.2 15.4 13 8 16Z";

/**
 * The blossom the Perch mark's dot becomes: five broad notched petals shaded from a cherry-pink
 * heart to a pale tip, a darker eye and a ring of anthers. Deeper than the branch's blossoms, so it
 * still reads at 20px on a blush tile. `r` is centre to petal tip.
 */
export function Blossom({ r, class: cls }: { readonly r: number; readonly class?: string }) {
  // Each blossom has its own gradient id: a page can show more than one mark.
  const id = `sk-mark-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <g class={cls}>
      <defs>
        <linearGradient id={id} x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" class="sk-mark-base" />
          <stop offset="1" class="sk-mark-tip" />
        </linearGradient>
      </defs>
      {[0, 72, 144, 216, 288].map((deg) => (
        <path key={deg} class="blossom-petal" d={petalD(r)} fill={`url(#${id})`} transform={`rotate(${deg})`} />
      ))}
      <circle class="blossom-centre" r={(r * 0.22).toFixed(1)} />
      {[0, 72, 144, 216, 288].map((deg) => {
        const a = ((deg + 36) * Math.PI) / 180;
        return <circle key={deg} class="blossom-anther" cx={(Math.sin(a) * r * 0.36).toFixed(1)} cy={(-Math.cos(a) * r * 0.36).toFixed(1)} r={(r * 0.06).toFixed(1)} />;
      })}
    </g>
  );
}

export { Petals } from "./sakura/Petals";
export { Branch } from "./sakura/Branch";
