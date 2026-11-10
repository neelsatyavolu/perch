/**
 * Perch's one token file: five themes and five accents, values from DESIGN.md.
 * A theme sets every surface and text colour; the accent is picked separately and
 * works on every theme. Layout, type and spacing never change with the theme.
 */

export const THEME_NAMES = ["ink", "graphite", "dusk", "paper", "contrast"] as const;
export const ACCENT_NAMES = ["blue", "teal", "amber", "rose", "mono"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];
export type AccentName = (typeof ACCENT_NAMES)[number];
export type DarkThemeName = Exclude<ThemeName, "paper">;

export type Theme = {
  readonly label: string;
  readonly dark: boolean;
  readonly canvas: string;
  readonly card: string;
  readonly raised: string;
  readonly ink: string;
  readonly body: string;
  readonly mute: string;
  readonly hair: string;
  readonly hairStrong: string;
  readonly hover: string;
  readonly btnBg: string;
  readonly btnFg: string;
};

export const THEMES: Readonly<Record<ThemeName, Theme>> = Object.freeze({
  ink: {
    label: "Ink", dark: true, canvas: "#0E0E0D", card: "#141413", raised: "#1A1A18",
    ink: "#F2F0EA", body: "rgba(242,240,234,0.86)", mute: "#8B8A87",
    hair: "rgba(242,240,234,0.08)", hairStrong: "rgba(242,240,234,0.18)", hover: "rgba(255,255,255,0.08)",
    btnBg: "#FCFDFF", btnFg: "#000000",
  },
  graphite: {
    label: "Graphite", dark: true, canvas: "#1C1D20", card: "#232428", raised: "#2B2C31",
    ink: "#F2F3F5", body: "rgba(242,243,245,0.86)", mute: "#9A9DA3",
    hair: "rgba(255,255,255,0.07)", hairStrong: "rgba(255,255,255,0.14)", hover: "rgba(255,255,255,0.06)",
    btnBg: "#F2F3F5", btnFg: "#1C1D20",
  },
  dusk: {
    label: "Dusk", dark: true, canvas: "#0E1116", card: "#141922", raised: "#1B2130",
    ink: "#EEF2F8", body: "rgba(238,242,248,0.86)", mute: "#8E98A8",
    hair: "rgba(255,255,255,0.07)", hairStrong: "rgba(255,255,255,0.14)", hover: "rgba(255,255,255,0.05)",
    btnBg: "#EEF2F8", btnFg: "#0E1116",
  },
  paper: {
    label: "Paper", dark: false, canvas: "#F7F5EF", card: "#FBFAF6", raised: "#EFECE4",
    ink: "#16161A", body: "rgba(22,22,26,0.86)", mute: "#676667",
    hair: "rgba(22,22,26,0.10)", hairStrong: "rgba(22,22,26,0.22)", hover: "rgba(0,0,0,0.04)",
    btnBg: "#16161A", btnFg: "#F7F5EF",
  },
  contrast: {
    label: "Contrast", dark: true, canvas: "#000000", card: "#000000", raised: "#141414",
    ink: "#FFFFFF", body: "#FFFFFF", mute: "#C8C8C8",
    hair: "rgba(255,255,255,0.28)", hairStrong: "rgba(255,255,255,0.5)", hover: "rgba(255,255,255,0.1)",
    btnBg: "#FFFFFF", btnFg: "#000000",
  },
});

export type Accent = { readonly label: string; readonly dark: string; readonly light: string };

export const ACCENTS: Readonly<Record<AccentName, Accent>> = Object.freeze({
  blue: { label: "Blue", dark: "#4C8DFF", light: "#2A63CC" },
  teal: { label: "Teal", dark: "#2EC4B6", light: "#0B7C73" },
  amber: { label: "Amber", dark: "#F5A524", light: "#9C5A00" },
  rose: { label: "Rose", dark: "#FF6B8A", light: "#C93558" },
  mono: { label: "Mono", dark: "#E6E8EB", light: "#2A2C30" },
});

export const STATE_COLOURS = Object.freeze({ ok: "#4FBF85", warn: "#D9A23A", dangerDark: "#EE5A4B", dangerLight: "#BC2E23" });

export function accentFor(accent: AccentName, theme: ThemeName): string {
  return THEMES[theme].dark ? ACCENTS[accent].dark : ACCENTS[accent].light;
}

/** Every CSS custom property Perch's pages read, for one theme and accent. */
export function tokenVars(theme: ThemeName, accent: AccentName): Readonly<Record<string, string>> {
  const t = THEMES[theme];
  const a = accentFor(accent, theme);
  return Object.freeze({
    "--canvas": t.canvas,
    "--card": t.card,
    "--raised": t.raised,
    "--ink": t.ink,
    "--body": t.body,
    "--mute": t.mute,
    "--hair": t.hair,
    "--hair-strong": t.hairStrong,
    "--hover": t.hover,
    "--btn-bg": t.btnBg,
    "--btn-fg": t.btnFg,
    "--accent": a,
    "--accent-soft": t.dark ? `color-mix(in srgb, ${a} 22%, ${t.raised})` : rgba(a, 0.1),
    "--ok": STATE_COLOURS.ok,
    "--warn": t.dark ? STATE_COLOURS.warn : "#8A5E12",
    "--danger": t.dark ? STATE_COLOURS.dangerDark : STATE_COLOURS.dangerLight,
    "--pop": "none",
  });
}

type Rgba = { r: number; g: number; b: number; a: number };

function parse(colour: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(colour);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  throw new Error(`Unsupported colour: ${colour}`);
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parse(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio; a translucent foreground is composited over the background first. */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parse(background);
  const fg = parse(foreground);
  const mixed = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
  const [hi, lo] = [luminance(mixed), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
