/**
 * Generates the one token file, src/styles/tokens.css, and the theme list, src/theme/names.gen.ts,
 * from the theme and accent tables in DESIGN.md. Run `bun run tokens` after changing DESIGN.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Theme = {
  name: string;
  dark: boolean;
  canvas: string;
  card: string;
  raised: string;
  ink: string;
  body: string;
  mute: string;
  hair: string;
  hairStrong: string;
  btnBg: string;
  btnFg: string;
};
export type Accent = { name: string; dark: string; light: string };
export type Design = { themes: Theme[]; accents: Accent[]; ok: string; warn: string; danger: { dark: string; light: string } };

/** Hover fills are not in DESIGN.md's table; these come from the approved preview. */
const HOVER: Record<string, number> = { ink: 0.08, graphite: 0.06, dusk: 0.05, paper: 0.04, contrast: 0.1 };

function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`DESIGN.md has no "## ${heading}" section`);
  const end = md.indexOf("\n## ", start + 4);
  return md.slice(start, end < 0 ? undefined : end);
}

function table(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|[\s|:-]+\|$/.test(l))
    .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
}

const HEX = /`(#[0-9A-Fa-f]{6})`/g;
const hexes = (cell: string) => [...cell.matchAll(HEX)].map((m) => m[1]!.toUpperCase());

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** A cell such as `#A1A4A5`, "ink at 86%", "white 6%" or "black 12%". */
function colour(cell: string, ink: string): string {
  const hex = hexes(cell)[0];
  if (hex) return hex;
  const m = cell.match(/^(ink at|white|black) (\d+)%$/);
  if (!m) throw new Error(`DESIGN.md: cannot read the colour "${cell}"`);
  const base = m[1] === "ink at" ? ink : m[1] === "white" ? "#FFFFFF" : "#000000";
  return rgba(base, Number(m[2]) / 100);
}

export function parseDesign(md: string): Design {
  const rows = table(section(md, "Themes"));
  const header = rows[0]!.slice(1).map((n) => n.toLowerCase());
  // Row labels are "canvas (tab strip, sidebar)", "hairline", ...: matched without the note.
  const row = (label: string) => {
    const found = rows.find((r) => r[0]!.toLowerCase().replace(/\s*\(.*\)$/, "") === label);
    if (!found) throw new Error(`DESIGN.md: the theme table has no "${label}" row`);
    return found.slice(1);
  };
  const themes = header.map((name, i): Theme => {
    const ink = hexes(row("ink")[i]!)[0]!;
    const [btnBg, btnFg] = hexes(row("primary button")[i]!);
    const canvas = hexes(row("canvas")[i]!)[0]!;
    return {
      name,
      dark: name !== "paper",
      canvas,
      card: hexes(row("card")[i]!)[0]!,
      raised: hexes(row("elevated")[i]!)[0]!,
      ink,
      body: colour(row("body")[i]!, ink),
      mute: colour(row("mute")[i]!, ink),
      hair: colour(row("hairline")[i]!, ink),
      hairStrong: colour(row("hairline-strong")[i]!, ink),
      btnBg: btnBg!,
      btnFg: btnFg!,
    };
  });
  const accents = table(section(md, "Accents"))
    .slice(1)
    .map((r): Accent => {
      const name = r[0]!.replace(/\s*\(default\)\s*/, "").toLowerCase();
      return { name, dark: hexes(r[1]!)[0]!, light: hexes(r[2]!)[0]! };
    });
  const states = section(md, "Accents");
  const pick = (label: string) => states.match(new RegExp(`${label} \`(#[0-9A-Fa-f]{6})\``))?.[1]?.toUpperCase();
  const dangerLight = states.match(/`(#[0-9A-Fa-f]{6})` on Paper/)?.[1]?.toUpperCase();
  if (!pick("ok") || !pick("warn") || !pick("danger") || !dangerLight) throw new Error("DESIGN.md: state colours are missing");
  return { themes, accents, ok: pick("ok")!, warn: pick("warn")!, danger: { dark: pick("danger")!, light: dangerLight } };
}

export function renderCss(d: Design): string {
  const out = [
    "/* Generated from DESIGN.md by scripts/gen-tokens.ts. Do not edit; run `bun run tokens`. */",
    ":root {",
    '  --sans: "Geist", ui-sans-serif, -apple-system, system-ui, sans-serif;',
    '  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;',
    '  --serif: "Geist Serif", Georgia, serif;',
    "  --ease: cubic-bezier(0.2, 0, 0, 1);",
    "  --t-hover: 120ms; --t-menu: 180ms; --t-panel: 240ms;",
    "  --r-control: 8px; --r-panel: 12px; --r-chip: 6px;",
    `  --ok: ${d.ok}; --warn: ${d.warn};`,
    "}",
  ];
  for (const t of d.themes) {
    out.push(
      `:root[data-theme="${t.name}"] {`,
      `  color-scheme: ${t.dark ? "dark" : "light"};`,
      `  --canvas: ${t.canvas}; --card: ${t.card}; --raised: ${t.raised};`,
      `  --ink: ${t.ink}; --body: ${t.body}; --mute: ${t.mute};`,
      `  --hair: ${t.hair}; --hair-strong: ${t.hairStrong}; --hover: ${rgba(t.dark ? "#FFFFFF" : "#000000", HOVER[t.name] ?? 0.06)};`,
      `  --btn-bg: ${t.btnBg}; --btn-fg: ${t.btnFg};`,
      `  --danger: ${t.dark ? d.danger.dark : d.danger.light};`,
      `  --pop: ${t.dark ? "0 8px 24px rgba(0, 0, 0, 0.45)" : "0 8px 24px rgba(10, 10, 12, 0.10)"};`,
      `  --accent: var(${t.dark ? "--accent-dark" : "--accent-light"});`,
      `  --accent-soft: ${t.dark ? "color-mix(in srgb, var(--accent) 22%, var(--raised))" : "color-mix(in srgb, var(--accent) 10%, transparent)"};`,
      "}",
    );
  }
  for (const a of d.accents) out.push(`:root[data-accent="${a.name}"] { --accent-dark: ${a.dark}; --accent-light: ${a.light}; }`);
  return `${out.join("\n")}\n`;
}

export function renderNames(d: Design): string {
  const themes = d.themes.map((t) => `  { id: "${t.name}", dark: ${t.dark}, canvas: "${t.canvas}" },`).join("\n");
  const accents = d.accents.map((a) => `  { id: "${a.name}", dark: "${a.dark}", light: "${a.light}" },`).join("\n");
  return [
    "// Generated from DESIGN.md by scripts/gen-tokens.ts. Do not edit; run `bun run tokens`.",
    `export const THEMES = [\n${themes}\n] as const;`,
    `export const ACCENTS = [\n${accents}\n] as const;`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const design = parseDesign(readFileSync(join(root, "..", "DESIGN.md"), "utf8"));
  writeFileSync(join(root, "src", "styles", "tokens.css"), renderCss(design));
  writeFileSync(join(root, "src", "theme", "names.gen.ts"), renderNames(design));
  process.stdout.write(`tokens: ${design.themes.length} themes, ${design.accents.length} accents\n`);
}
