/**
 * Picks the backend for a page: the browser's `window.perch` bridge when Perch injected it,
 * the fake backend in a `--mode fake` build (development, smoke tests), otherwise none, and
 * the page says perchd isn't running. A production build never falls back to sample data.
 */

import type { Appearance, PerchApi } from "../api";
import { ACCENT_NAMES, type AccentName, THEME_NAMES, type ThemeName } from "../theme/tokens";
import { installHostBridge } from "./host";
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
  installHostBridge(win);
  // A fake build shows its sample data even inside Perch (screenshots of the real browser).
  const bridge = (win as Window & { perch?: unknown }).perch;
  if (isBridge(bridge) && import.meta.env?.MODE !== "fake") return createRpcApi(bridge);
  if (import.meta.env?.MODE === "fake") {
    const { createFakeApi } = await import("./fake");
    const params = new URLSearchParams(win.location.search);
    return createFakeApi({
      // Follows the browser's light or dark theme unless the URL picks one.
      appearance: {
        ...(win.matchMedia?.("(prefers-color-scheme: light)").matches ? { theme: "paper" as ThemeName } : {}),
        ...appearanceFromQuery(win.location.search),
      },
      onboarding: params.has("welcome") ? { finished: false, done: [] } : undefined,
    });
  }
  return null;
}
