import { Blossom } from "./Sakura";

/** The bird, a pointer whose tip is its beak and whose stem its tail, set on the branch (branding/perch-mark.svg). */
const BIRD = "M352 236 L352 676 L462 580 L546 760 L614 732 L532 556 L680 556 Z";
const PERCHED = "translate(40 -69) rotate(-40 512 512)";

/**
 * The Perch mark: a pointer that is also a bird, perched on a branch, its eye the perch dot, drawn
 * in the theme's colours. In Sakura mode the eye is a blossom.
 */
export function PerchMark({ size = 48, tile = true }: { readonly size?: number; readonly tile?: boolean }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      {tile && <rect width="1024" height="1024" rx="228" style={{ fill: "var(--raised)" }} />}
      <g transform="translate(512 512) scale(1.32) translate(-512 -518)">
        <rect x="176" y="686" width="672" height="30" rx="15" style={{ fill: "var(--ink)", opacity: 0.45 }} />
        <path transform={PERCHED} d={BIRD} style={{ fill: "var(--ink)", stroke: "var(--ink)", strokeWidth: 28, strokeLinejoin: "round" }} />
        <circle class="mark-dot" cx="373" cy="408" r="46" style={{ fill: "var(--accent)" }} />
        <g transform="translate(373 408)">
          <Blossom r={64} class="blossom" />
        </g>
      </g>
    </svg>
  );
}
