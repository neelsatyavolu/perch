/**
 * The blossoming branch in the new tab page's top right corner (DESIGN.md, Sakura mode): dark
 * tapered bark, clusters of five-petal blossoms with stamens hanging on thin stems, closed buds and
 * a few bronze young leaves. In Yozakura a soft moon sits behind it. Decorative only.
 */

import { along, cluster, highlightPath, leafD, lenticels, limbPath, petalD, type Cluster, type Flower, type Pt } from "./art";

export const BRANCH_VIEW = { width: 460, height: 330 } as const;

const MAIN: readonly Pt[] = [[474, -8], [396, 34], [318, 82], [232, 132], [150, 190], [86, 236], [26, 268]];
const UP: readonly Pt[] = [along(MAIN, 0.3), [282, 52], [226, 30], [168, 26]];
const DOWN: readonly Pt[] = [along(MAIN, 0.52), [250, 186], [238, 236], [226, 270]];
const TIP: readonly Pt[] = [along(MAIN, 0.76), [96, 188], [62, 172]];

const LIMBS = [
  { pts: MAIN, w0: 15, w1: 2.4, seed: 11 },
  { pts: UP, w0: 6, w1: 1.6, seed: 12 },
  { pts: DOWN, w0: 5.5, w1: 1.5, seed: 13 },
  { pts: TIP, w0: 4.5, w1: 1.4, seed: 14 },
] as const;

/** Where the clusters grow, how big their flowers are, and whether they hang (1) or sit sideways (lower). */
export const CLUSTERS: readonly Cluster[] = [
  cluster(along(MAIN, 0.08), 15, 20, 0.8),
  cluster(along(MAIN, 0.2), 17, 21, 0.95),
  cluster(along(MAIN, 0.33), 16, 31, 0.3),
  cluster(along(MAIN, 0.42), 17, 22),
  cluster(along(MAIN, 0.56), 16, 32, 0.25),
  cluster(along(MAIN, 0.64), 16, 23),
  cluster(along(MAIN, 0.78), 15, 24, 0.9),
  cluster(along(MAIN, 0.9), 13, 33, 0.35),
  cluster(along(MAIN, 0.99), 12, 25, 0.6),
  cluster(along(UP, 0.4), 14, 26, 0.45),
  cluster(along(UP, 0.75), 14, 34, 0.15),
  cluster(along(UP, 1), 13, 27, 0.2),
  cluster(along(DOWN, 0.45), 14, 28, 1.25),
  cluster(along(DOWN, 1), 13, 29),
  cluster(along(TIP, 0.6), 12, 35, 0.3),
  cluster(along(TIP, 1), 12, 30, 0.4),
];

/** Every flower centre, in the branch's own coordinates: where falling petals can start. */
export const FLOWER_POINTS: readonly Pt[] = CLUSTERS.flatMap((c) => c.flowers.map((f) => [f.x, f.y] as Pt));

const STAMENS = 16;

function Blossom({ f }: { readonly f: Flower }) {
  return (
    <g transform={`translate(${f.x.toFixed(1)} ${f.y.toFixed(1)}) rotate(${f.rot.toFixed(1)}) scale(1 ${f.tilt.toFixed(2)})`}>
      {f.petals.map((p, i) => (
        <path key={i} class="sk-petal" d={petalD(f.r * p.k)} transform={`rotate(${(i * 72 + p.a).toFixed(1)})`} />
      ))}
      <circle class="sk-eye" r={(f.r * 0.24).toFixed(1)} />
      {Array.from({ length: STAMENS }, (_, i) => {
        const a = (i / STAMENS) * Math.PI * 2 + (i % 2) * 0.12;
        const len = f.r * (i % 3 === 0 ? 0.52 : 0.44);
        const x = Math.cos(a) * len;
        const y = Math.sin(a) * len;
        return (
          <g key={i}>
            <line class="sk-stamen" x1="0" y1="0" x2={x.toFixed(1)} y2={y.toFixed(1)} />
            <circle class="sk-anther" cx={x.toFixed(1)} cy={y.toFixed(1)} r={(f.r * 0.055).toFixed(2)} />
          </g>
        );
      })}
    </g>
  );
}

function Stem({ from, to }: { readonly from: Pt; readonly to: Pt }) {
  // A slight sag, as a stem carrying a flower has.
  const mx = (from[0] + to[0]) / 2 + (to[1] - from[1]) * 0.12;
  const my = (from[1] + to[1]) / 2 - (to[0] - from[0]) * 0.12;
  return <path class="sk-stem" d={`M${from[0].toFixed(1)} ${from[1].toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${to[0].toFixed(1)} ${to[1].toFixed(1)}`} />;
}

export function Branch() {
  return (
    <svg class="sakura-only sakura-branch" viewBox={`0 0 ${BRANCH_VIEW.width} ${BRANCH_VIEW.height}`} width={BRANCH_VIEW.width} height={BRANCH_VIEW.height} aria-hidden="true">
      <defs>
        <linearGradient id="sk-petal" x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" class="sk-petal-base" />
          <stop offset="0.42" class="sk-petal-mid" />
          <stop offset="1" class="sk-petal-tip" />
        </linearGradient>
        <radialGradient id="sk-eye">
          <stop offset="0" class="sk-eye-in" />
          <stop offset="1" class="sk-eye-out" />
        </radialGradient>
        <linearGradient id="sk-bark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="sk-bark-hi" />
          <stop offset="1" class="sk-bark-lo" />
        </linearGradient>
        <linearGradient id="sk-bud" x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" class="sk-bud-base" />
          <stop offset="1" class="sk-bud-tip" />
        </linearGradient>
        <radialGradient id="sk-moon">
          <stop offset="0" class="sk-moon-in" />
          <stop offset="0.55" class="sk-moon-mid" />
          <stop offset="1" class="sk-moon-out" />
        </radialGradient>
      </defs>
      <g class="sk-moon">
        <circle cx="318" cy="96" r="120" fill="url(#sk-moon)" />
        <circle class="sk-moon-disc" cx="318" cy="96" r="38" />
      </g>
      <g class="sk-sway">
        {LIMBS.map((l) => (
          <g key={l.seed}>
            <path class="sk-bark" d={limbPath(l.pts, l.w0, l.w1, l.seed)} />
            <path class="sk-bark-light" d={highlightPath(l.pts, l.w0, l.w1)} />
            {lenticels(l.pts, l.w0, l.w1, l.seed + 100).map(([x1, y1, x2, y2], i) => (
              <line key={i} class="sk-lenticel" x1={x1.toFixed(1)} y1={y1.toFixed(1)} x2={x2.toFixed(1)} y2={y2.toFixed(1)} />
            ))}
          </g>
        ))}
        {CLUSTERS.map((c, i) => (
          <g key={i} class="sk-cluster" style={{ "--sk-delay": `${(-i * 0.83).toFixed(2)}s`, transformOrigin: `${c.at[0]}px ${c.at[1]}px` } as Record<string, string>}>
            {c.leaves.map((l, j) => (
              <g key={`l${j}`} transform={`translate(${l.x.toFixed(1)} ${l.y.toFixed(1)}) rotate(${l.rot.toFixed(1)})`}>
                <path class="sk-leaf" d={leafD(l.r * 1.3)} />
                <line class="sk-midrib" x1="0" y1="0" x2="0" y2={(-l.r * 1.2).toFixed(1)} />
              </g>
            ))}
            {[...c.flowers, ...c.buds].map((f, j) => <Stem key={`s${j}`} from={f.from} to={[f.x, f.y]} />)}
            {c.buds.map((b, j) => (
              <g key={`b${j}`} transform={`translate(${b.x.toFixed(1)} ${b.y.toFixed(1)}) rotate(${b.rot.toFixed(1)})`}>
                <ellipse class="sk-bud" cx="0" cy={(b.r * 0.9).toFixed(1)} rx={(b.r * 0.62).toFixed(1)} ry={b.r.toFixed(1)} />
                <path class="sk-sepal" d={`M${(-b.r * 0.55).toFixed(1)} ${(b.r * 0.3).toFixed(1)}L0 ${(-b.r * 0.15).toFixed(1)}L${(b.r * 0.55).toFixed(1)} ${(b.r * 0.3).toFixed(1)}Z`} />
              </g>
            ))}
            {c.flowers.map((f, j) => <Blossom key={`f${j}`} f={f} />)}
          </g>
        ))}
      </g>
    </svg>
  );
}
