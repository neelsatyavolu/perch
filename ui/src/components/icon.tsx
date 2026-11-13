/** Lucide icons (ISC licence), inlined: 16px, 1.5 stroke, coloured by their text role (spec 6.5). */

const PATHS = {
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  pen: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  panelleft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  stop: '<rect width="10" height="10" x="7" y="7" rx="1.5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  expand: '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  files: '<path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/><path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z"/><path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg class="i" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />;
}

/** One cherry petal, 16 units tall and notched at its tip; the same shape as ui-pages' Sakura.tsx. */
export const PETAL_PATH = "M8 16C0.6 13 -0.8 5.2 3.4 0.9C5 0.4 6.6 1.3 8 3.3C9.4 1.3 11 0.4 12.6 0.9C16.8 5.2 15.4 13 8 16Z";

/** A broad cherry petal pointing up from (0, 0), `r` long, notched at the tip (ui-pages' sakura/art.ts petalD). */
function petalD(r: number): string {
  const w = r * 0.56;
  const f = (n: number) => Math.round(n * 10) / 10;
  return `M0 0C${f(-w * 0.55)} ${f(-r * 0.12)} ${f(-w * 1.02)} ${f(-r * 0.55)} ${f(-w * 0.78)} ${f(-r * 0.88)}C${f(-w * 0.6)} ${f(-r * 1.04)} ${f(-w * 0.22)} ${f(-r * 1.04)} 0 ${f(-r * 0.9)}C${f(w * 0.22)} ${f(-r * 1.04)} ${f(w * 0.6)} ${f(-r * 1.04)} ${f(w * 0.78)} ${f(-r * 0.88)}C${f(w * 1.02)} ${f(-r * 0.55)} ${f(w * 0.55)} ${f(-r * 0.12)} 0 0Z`;
}

/**
 * Sakura mode's blossom (DESIGN.md): five broad petals shaded from a cherry heart to a pale tip, a
 * dark eye and a ring of anthers. Shown only under data-sakura. `r` is centre to petal tip.
 */
function Blossom({ r }: { r: number }) {
  return (
    <g class="blossom">
      <defs>
        <linearGradient id="sk-mark-petal" x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" class="sk-mark-base" />
          <stop offset="1" class="sk-mark-tip" />
        </linearGradient>
      </defs>
      {[0, 72, 144, 216, 288].map((deg) => (
        <path key={deg} class="blossom-petal" d={petalD(r)} transform={`rotate(${deg})`} />
      ))}
      <circle class="blossom-centre" r={r * 0.22} />
      {[0, 72, 144, 216, 288].map((deg) => {
        const a = ((deg + 36) * Math.PI) / 180;
        return <circle key={deg} class="blossom-anther" cx={Math.sin(a) * r * 0.36} cy={-Math.cos(a) * r * 0.36} r={r * 0.06} />;
      })}
    </g>
  );
}

/** The Perch mark: a flat single-colour glyph, never a sparkle (spec 6.5); in Sakura mode the dot is a blossom. `bare` drops the tile and draws only the perch, `size` wide. */
/** The bird, a pointer whose tip is its beak and whose stem its tail, set on the branch (branding/perch-mark.svg). */
const BIRD = "M352 236 L352 676 L462 580 L546 760 L614 732 L532 556 L680 556 Z";
const PERCHED = "translate(40 -69) rotate(-40 512 512)";

function MarkParts({ ink }: { ink: string }) {
  return (
    <>
      <rect x="176" y="686" width="672" height="30" rx="15" style={`fill:${ink};opacity:0.45`} />
      <path transform={PERCHED} d={BIRD} style={`fill:${ink};stroke:${ink};stroke-width:28;stroke-linejoin:round`} />
      <circle class="mark-dot" cx="373" cy="408" r="46" style="fill:var(--accent)" />
      <g transform="translate(373 408)">
        <Blossom r={64} />
      </g>
    </>
  );
}

export function PerchMark({ size = 48, bare = false }: { size?: number; bare?: boolean }) {
  if (bare)
    return (
      <svg class="mark" width={size} height={Math.round((size * 450) / 700)} viewBox="160 290 700 450" aria-hidden="true">
        <MarkParts ink="var(--mute)" />
      </svg>
    );
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <rect width="1024" height="1024" rx="228" style="fill:var(--raised)" />
      <g transform="translate(512 512) scale(1.32) translate(-512 -518)">
        <MarkParts ink="var(--ink)" />
      </g>
    </svg>
  );
}

/**
 * The perch dot (spec 6.1, DESIGN.md): breathes while a task is really running, still while it
 * waits for approval, and absent otherwise. The state is always said in words next to it.
 */
export function PerchDot({ status, title }: { status: "idle" | "running" | "waiting"; title?: string }) {
  if (status === "idle") return null;
  return <span class={status === "running" ? "dot live" : "dot"} data-status={status} title={title} aria-hidden="true" />;
}
