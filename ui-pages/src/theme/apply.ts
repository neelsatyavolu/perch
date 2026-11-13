/** Puts the theme tokens on a page, following Match system and macOS Increase Contrast. */

import type { Appearance } from "../api";
import { ACCENT_NAMES, THEMES, THEME_NAMES, isLightTheme, isSakura, lightPartner, type ThemeName, tokenVars } from "./tokens";

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
  if (appearance.matchSystem) return prefs.prefersDark ? appearance.darkTheme : lightPartner(appearance.darkTheme);
  return appearance.theme;
}

export function applyAppearance(root: HTMLElement, appearance: Appearance, prefs: SystemPrefs): ThemeName {
  const theme = resolveTheme(appearance, prefs);
  for (const [name, value] of Object.entries(tokenVars(theme, appearance.accent))) root.style.setProperty(name, value);
  root.style.colorScheme = THEMES[theme].dark ? "dark" : "light";
  root.dataset.theme = theme;
  // Light-theme rules key on the tone, so Sakura gets Paper's treatment without repeating it.
  root.dataset.tone = THEMES[theme].dark ? "dark" : "light";
  if (isSakura(theme)) root.dataset.sakura = "";
  else delete root.dataset.sakura;
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
    const value: unknown = JSON.parse(raw);
    return isAppearance(value) ? value : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Whether a value (the cache, or the browser's appearance event) is a complete appearance. */
export function isAppearance(value: unknown): value is Appearance {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Appearance>;
  return (
    (THEME_NAMES as readonly string[]).includes(String(v.theme)) &&
    (ACCENT_NAMES as readonly string[]).includes(String(v.accent)) &&
    (THEME_NAMES as readonly string[]).includes(String(v.darkTheme)) &&
    !isLightTheme(String(v.darkTheme)) &&
    typeof v.matchSystem === "boolean" &&
    typeof v.hideChrome === "boolean" &&
    typeof v.revealOnHover === "boolean" &&
    (v.density === "comfortable" || v.density === "compact")
  );
}
