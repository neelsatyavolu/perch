/** Puts the theme tokens on a page, following Match system and macOS Increase Contrast. */

import type { Appearance } from "../api";
import { ACCENT_NAMES, THEMES, THEME_NAMES, type ThemeName, tokenVars } from "./tokens";

export type SystemPrefs = { readonly prefersDark: boolean; readonly prefersMoreContrast: boolean };

export const DEFAULT_APPEARANCE: Appearance = Object.freeze({
  theme: "ink",
  accent: "blue",
  matchSystem: false,
  darkTheme: "ink",
  hideChrome: false,
  revealOnHover: true,
  density: "comfortable",
});

export function resolveTheme(appearance: Appearance, prefs: SystemPrefs): ThemeName {
  if (prefs.prefersMoreContrast) return "contrast";
  if (appearance.matchSystem) return prefs.prefersDark ? appearance.darkTheme : "paper";
  return appearance.theme;
}

export function applyAppearance(root: HTMLElement, appearance: Appearance, prefs: SystemPrefs): ThemeName {
  const theme = resolveTheme(appearance, prefs);
  for (const [name, value] of Object.entries(tokenVars(theme, appearance.accent))) root.style.setProperty(name, value);
  root.style.colorScheme = THEMES[theme].dark ? "dark" : "light";
  root.dataset.theme = theme;
  root.dataset.accent = appearance.accent;
  root.dataset.density = appearance.density;
  return theme;
}

export function readSystemPrefs(win: Window): SystemPrefs {
  return {
    prefersDark: win.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
    prefersMoreContrast: win.matchMedia?.("(prefers-contrast: more)").matches ?? false,
  };
}

/** Calls `onChange` when macOS switches light/dark or Increase Contrast. */
export function watchSystemPrefs(win: Window, onChange: (prefs: SystemPrefs) => void): () => void {
  const queries = ["(prefers-color-scheme: dark)", "(prefers-contrast: more)"].map((q) => win.matchMedia?.(q)).filter(Boolean) as MediaQueryList[];
  const handler = () => onChange(readSystemPrefs(win));
  for (const q of queries) q.addEventListener("change", handler);
  return () => queries.forEach((q) => q.removeEventListener("change", handler));
}

type KeyValueStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const CACHE_KEY = "perch.appearance";

/**
 * The last appearance is cached so the next page paints in the right theme before the API answers.
 * Appearance is not secret; a bad or missing cache falls back to the defaults.
 */
export function cacheAppearance(appearance: Appearance, store: KeyValueStore): void {
  try {
    store.setItem(CACHE_KEY, JSON.stringify(appearance));
  } catch {
    // Storage can be unavailable; the page still renders with the API's answer.
  }
}

export function readCachedAppearance(store: KeyValueStore): Appearance {
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const value = JSON.parse(raw) as Partial<Appearance>;
    return isAppearance(value) ? value : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function isAppearance(v: Partial<Appearance>): v is Appearance {
  return (
    (THEME_NAMES as readonly string[]).includes(String(v.theme)) &&
    (ACCENT_NAMES as readonly string[]).includes(String(v.accent)) &&
    (THEME_NAMES as readonly string[]).includes(String(v.darkTheme)) &&
    String(v.darkTheme) !== "paper" &&
    typeof v.matchSystem === "boolean" &&
    typeof v.hideChrome === "boolean" &&
    typeof v.revealOnHover === "boolean" &&
    (v.density === "comfortable" || v.density === "compact")
  );
}
