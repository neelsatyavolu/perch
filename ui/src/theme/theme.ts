/**
 * Applies a theme and accent to the page through the token file's data attributes. "System"
 * follows macOS: Ink or Paper by appearance, and Contrast when Increase Contrast is on.
 */

import type { AccentId, ThemeId } from "../api/config";
import { ACCENTS, THEMES } from "./names.gen";

type Media = (query: string) => { matches: boolean; addEventListener?: (type: "change", fn: () => void) => void; removeEventListener?: (type: "change", fn: () => void) => void };

export function resolveTheme(theme: ThemeId, media: Media): Exclude<ThemeId, "system"> {
  if (theme !== "system") return theme;
  if (media("(prefers-contrast: more)").matches) return "contrast";
  return media("(prefers-color-scheme: dark)").matches ? "ink" : "paper";
}

/** Sets the attributes now, and keeps "system" in step with macOS. Returns a cleanup. */
export function applyTheme(root: HTMLElement, theme: ThemeId, accent: AccentId, media: Media = (q) => window.matchMedia(q)): () => void {
  const set = () => {
    root.dataset.theme = resolveTheme(theme, media);
    root.dataset.accent = accent;
  };
  set();
  if (theme !== "system") return () => {};
  const queries = ["(prefers-contrast: more)", "(prefers-color-scheme: dark)"].map((q) => media(q));
  for (const q of queries) q.addEventListener?.("change", set);
  return () => {
    for (const q of queries) q.removeEventListener?.("change", set);
  };
}

/** The browser's Appearance settings (Settings › Appearance), as the shell passes them on. */
export type Appearance = { theme: string; accent: string; matchSystem: boolean; darkTheme: string };

const known = <T extends string>(ids: readonly { id: string }[], v: string, fallback: T): T => (ids.some((t) => t.id === v) ? (v as T) : fallback);

/**
 * Applies the browser's Appearance: its theme and accent, or with Match system on, the dark
 * theme it names when macOS is dark and Paper when light (Contrast when Increase Contrast is on),
 * like ui-pages/src/theme/apply.ts. Returns a cleanup.
 */
export function applyAppearance(root: HTMLElement, a: Appearance, media: Media = (q) => window.matchMedia(q)): () => void {
  const accent = known<AccentId>(ACCENTS, a.accent, "blue");
  const theme = known<Exclude<ThemeId, "system">>(THEMES, a.theme, "ink");
  const dark = known<Exclude<ThemeId, "system">>(THEMES, a.darkTheme, "ink");
  const set = () => {
    root.dataset.theme = media("(prefers-contrast: more)").matches ? "contrast" : !a.matchSystem ? theme : media("(prefers-color-scheme: dark)").matches ? dark : "paper";
    root.dataset.accent = accent;
  };
  set();
  const queries = ["(prefers-contrast: more)", "(prefers-color-scheme: dark)"].map((q) => media(q));
  for (const q of queries) q.addEventListener?.("change", set);
  return () => {
    for (const q of queries) q.removeEventListener?.("change", set);
  };
}
