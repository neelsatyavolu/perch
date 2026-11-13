/**
 * Sakura mode's decorations (DESIGN.md, Sakura mode): drifting petals, a blossoming branch, and
 * the blossom the Perch mark's dot turns into. Everything here renders always but shows only
 * under `:root[data-sakura]` (styles/sakura.css), so other themes pay nothing and switching
 * themes needs no re-render. All of it is decorative and hidden from assistive tech.
 */

/** One cherry petal, 16 units tall, notched at its tip like the real thing. */
export const PETAL_PATH = "M8 16C0.6 13 -0.8 5.2 3.4 0.9C5 0.4 6.6 1.3 8 3.3C9.4 1.3 11 0.4 12.6 0.9C16.8 5.2 15.4 13 8 16Z";

/** A five-petal blossom centred on (0, 0), `r` from centre to petal tip. */
export function Blossom({ r, class: cls, centre = true }: { readonly r: number; readonly class?: string; readonly centre?: boolean }) {
  const s = r / 16;
  return (
    <g class={cls}>
      {[0, 72, 144, 216, 288].map((deg) => (
        <path key={deg} d={PETAL_PATH} transform={`rotate(${deg}) translate(${-8 * s} ${-16 * s}) scale(${s})`} />
      ))}
      {centre && <circle class="blossom-centre" r={r * 0.2} />}
    </g>
  );
}

/** A fixed pseudo-random sequence, so petals land in the same places on every load. */
function seeded(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const PETAL_COUNT = 12;

/**
 * Petals drifting down behind the page. Each falls on its own track with its own sway, size and
 * tint; negative delays put them mid-flight on load. With Reduce Motion they rest in place.
 */
export function Petals() {
  return (
    <div class="sakura-only sakura-petals" aria-hidden="true">
      {Array.from({ length: PETAL_COUNT }, (_, i) => {
        const size = 10 + Math.round(seeded(i, 1) * 6);
        const fall = 15 + seeded(i, 2) * 10;
        const style = {
          "--x": `${Math.round(seeded(i, 3) * 96 + 2)}%`,
          "--y": `${Math.round(seeded(i, 4) * 88 + 4)}%`,
          "--size": `${size}px`,
          "--fall": `${fall.toFixed(1)}s`,
          "--delay": `${(-seeded(i, 5) * fall).toFixed(1)}s`,
          "--sway": `${(3 + seeded(i, 6) * 3).toFixed(1)}s`,
          "--drift": `${Math.round(18 + seeded(i, 7) * 26)}px`,
          "--spin": `${Math.round(120 + seeded(i, 8) * 240)}deg`,
        } as Record<string, string>;
        return (
          <span key={i} class={`sakura-petal tint-${i % 3}`} style={style}>
            <svg viewBox="0 0 16 16" width={size} height={size}>
              <path d={PETAL_PATH} />
            </svg>
          </span>
        );
      })}
    </div>
  );
}

/** Blossoms and buds along the branch: [x, y, petal radius, rotation, tint]. A radius of 0 is a bud. */
const FLOWERS: readonly (readonly [number, number, number, number, number])[] = [
  [222, 34, 15, 10, 0], [190, 58, 12, 40, 1], [246, 74, 11, -20, 2], [150, 72, 14, 25, 0],
  [118, 104, 11, -15, 1], [176, 112, 0, 0, 2], [86, 128, 13, 30, 2], [58, 152, 0, 0, 0],
  [204, 128, 10, 55, 0], [132, 140, 0, 0, 1],
];

/**
 * A blossoming branch reaching in from the top right of the new tab page: line art in mute, the
 * blossoms in the accent's tints. Hidden below 900px wide, where it would crowd the address box.
 */
export function Branch() {
  return (
    <svg class="sakura-only sakura-branch" viewBox="0 0 280 200" width="280" height="200" aria-hidden="true">
      <path class="twig main" d="M280 8C238 22 206 40 176 62S118 102 84 124S40 160 22 176" />
      <path class="twig" d="M206 42C214 56 230 66 248 72" />
      <path class="twig" d="M150 76C168 92 186 104 206 124" />
      <path class="twig" d="M110 104C120 118 124 130 130 140" />
      {FLOWERS.map(([x, y, r, rot, tint], i) =>
        r === 0 ? (
          <ellipse key={i} class={`bud tint-${tint}`} cx={x} cy={y} rx="4.5" ry="6" transform={`rotate(${rot + 30} ${x} ${y})`} />
        ) : (
          <g key={i} transform={`translate(${x} ${y}) rotate(${rot})`} class={`flower tint-${tint}`}>
            <Blossom r={r} />
          </g>
        ),
      )}
    </svg>
  );
}
