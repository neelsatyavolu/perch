/**
 * Applies a theme and accent to the page through the token file's data attributes. "System"
 * follows macOS: Ink or Paper by appearance, and Contrast when Increase Contrast is on.
 */

import type { AccentId, ThemeId } from "../api/config";

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
