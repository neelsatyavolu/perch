/** The Perch mark: a bar and the perch dot, drawn in the theme's colours. */
export function PerchMark({ size = 48, tile = true }: { readonly size?: number; readonly tile?: boolean }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      {tile && <rect width="1024" height="1024" rx="228" style={{ fill: "var(--raised)" }} />}
      <rect x="272" y="560" width="480" height="88" rx="12" style={{ fill: "var(--ink)" }} />
      <circle cx="632" cy="472" r="88" style={{ fill: "var(--accent)" }} />
    </svg>
  );
}
