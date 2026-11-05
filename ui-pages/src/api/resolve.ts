/**
 * Picks the backend for a page: the browser's `window.perch` bridge when Perch injected it,
 * the fake backend in a `--mode fake` build (development, smoke tests), otherwise none, and
 * the page says perchd isn't running. A production build never falls back to sample data.
 */

import type { Appearance, PerchApi } from "../api";
import { ACCENT_NAMES, type AccentName, THEME_NAMES, type ThemeName } from "../theme/tokens";
import { createRpcApi, isBridge } from "./rpc";

export function appearanceFromQuery(search: string): Partial<Appearance> {
  const params = new URLSearchParams(search);
  const theme = params.get("theme");
  const accent = params.get("accent");
  return {
    ...(theme && (THEME_NAMES as readonly string[]).includes(theme) ? { theme: theme as ThemeName } : {}),
    ...(accent && (ACCENT_NAMES as readonly string[]).includes(accent) ? { accent: accent as AccentName } : {}),
  };
}

export async function loadApi(win: Window): Promise<PerchApi | null> {
  const bridge = (win as Window & { perch?: unknown }).perch;
  if (isBridge(bridge)) return createRpcApi(bridge);
  if (import.meta.env?.MODE === "fake") {
    const { createFakeApi } = await import("./fake");
    const params = new URLSearchParams(win.location.search);
    return createFakeApi({
      appearance: appearanceFromQuery(win.location.search),
      onboarding: params.has("welcome") ? { finished: false, done: [] } : undefined,
    });
  }
  return null;
}
