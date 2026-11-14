import { Blossom } from "./Sakura";

/** The songbird: one circle for head and breast, a straight tail, a beak, its eye a hole (branding/perch-mark.svg). */
const BIRD = "M232 757L407.4 378.7A192.5 192.5 0 1 1 633.6 645ZM638 403.5a22.75 22.75 0 1 0 45.5 0a22.75 22.75 0 1 0-45.5 0ZM757 382.5L848 426.3L753.5 466.5ZM548.8 645h21v72h-21ZM601.3 634.5h21v82.5h-21Z";

/**
 * The Perch mark: a songbird perched on a branch, the bird in the theme's ink and the branch in its accent.
 * In Sakura mode a blossom sits on its head.
 */
export function PerchMark({ size = 48, tile = true }: { readonly size?: number; readonly tile?: boolean }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      {tile && <rect width="1024" height="1024" rx="228" style={{ fill: "var(--raised)" }} />}
      <g transform="translate(512 512) scale(1.2) translate(-512 -512)">
        <path d={BIRD} style={{ fill: "var(--ink)" }} />
        <rect x="169" y="708" width="686" height="42" rx="21" style={{ fill: "var(--accent)" }} />
        <g transform="translate(520 280)">
          <Blossom r={64} class="blossom" />
        </g>
      </g>
    </svg>
  );
}
