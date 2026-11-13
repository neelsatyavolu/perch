import { Blossom } from "./Sakura";

/** The bird, a pointer whose tip is its beak and whose stem its tail, set on the branch (branding/perch-mark.svg). */
const BIRD = "M352.0 258.0 L352.0 654.0 Q352 676 368.6 661.5 L445.4 594.5 Q462 580 471.3 599.9 L536.7 740.1 Q546 760 566.3 751.6 L593.7 740.4 Q614 732 604.7 712.1 L541.3 575.9 Q532 556 554.0 556.0 L658.0 556.0 Q680 556 664.3 540.6 L367.7 251.4 Q352 236 352.0 258.0 Z";
const PERCHED = "translate(40 -45) rotate(-40 512 512)";

/**
 * The Perch mark: a pointer that is also a bird, perched on a branch, drawn in the theme's colours.
 * In Sakura mode a blossom sits on its head.
 */
export function PerchMark({ size = 48, tile = true }: { readonly size?: number; readonly tile?: boolean }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      {tile && <rect width="1024" height="1024" rx="228" style={{ fill: "var(--raised)" }} />}
      <g transform="translate(512 512) scale(1.32) translate(-512 -518)">
        <rect x="176" y="686" width="672" height="30" rx="15" style={{ fill: "var(--ink)", opacity: 0.45 }} />
        <path transform={PERCHED} d={BIRD} style={{ fill: "var(--ink)" }} />
        <g transform="translate(384 438)">
          <Blossom r={64} class="blossom" />
        </g>
      </g>
    </svg>
  );
}
