/**
 * Where the page finds the app API. Inside Perch the browser hands the page a `perchApp` object
 * (docs/design/webui-hosting.md). In development the address carries it in the fragment, which
 * never reaches a server; the page removes it from the address bar at once.
 */

import { ACCENTS, THEMES } from "../theme/names.gen";

export type ThemeId = (typeof THEMES)[number]["id"] | "system";
export type AccentId = (typeof ACCENTS)[number]["id"];

export type AppConfig = { api: string; token: string; windowId: string; tabId: string | null; theme: ThemeId; accent: AccentId };
export type HostConfig = { api: string; token: string; windowId?: string; tabId?: string; theme?: string; accent?: string };
type Place = { href: string; replace: (url: string) => void };

const theme = (v: string | null | undefined): ThemeId => (v === "system" || THEMES.some((t) => t.id === v) ? (v as ThemeId) : "ink");
const accent = (v: string | null | undefined): AccentId => (ACCENTS.some((a) => a.id === v) ? (v as AccentId) : "blue");

export function readConfig(place: Place, host?: HostConfig): AppConfig | null {
  const url = new URL(place.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const pick = (name: string) => hash.get(name) ?? url.searchParams.get(name);
  if (host?.token) {
    return { api: host.api, token: host.token, windowId: host.windowId ?? "main", tabId: host.tabId ?? null, theme: theme(host.theme ?? pick("theme")), accent: accent(host.accent ?? pick("accent")) };
  }
  const token = hash.get("token");
  if (!token) return null;
  url.hash = "";
  place.replace(url.toString().replace(/#$/, ""));
  return { api: hash.get("api") ?? url.origin, token, windowId: pick("window") ?? "main", tabId: pick("tab"), theme: theme(pick("theme")), accent: accent(pick("accent")) };
}
