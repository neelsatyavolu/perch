/** User settings: one switch per feature (spec 5.9 "each has an off switch") and the sites with protections off. */

export type Feature = "blocker" | "banners" | "params" | "pip" | "speedKeys" | "linkPreview";

export type Settings = Readonly<Record<Feature, boolean> & { sitesOff: readonly string[] }>;

export const FEATURES: readonly { id: Feature; label: string; detail: string }[] = [
  { id: "blocker", label: "Block ads and trackers", detail: "EasyList and EasyPrivacy, built in." },
  { id: "banners", label: "Reject cookie banners", detail: "Clicks the reject option on common consent banners. Never accepts." },
  { id: "params", label: "Remove tracking parameters", detail: "utm_*, fbclid, gclid and similar, from links you open." },
  { id: "pip", label: "Picture in picture when you switch tabs", detail: "A playing video keeps playing in a small window." },
  { id: "speedKeys", label: "Playback speed keys", detail: "[ slows a video down, ] speeds it up." },
  { id: "linkPreview", label: "Link preview", detail: "Hold Shift while pointing at a link to see where it goes." },
];

export const DEFAULT_SETTINGS: Settings = {
  blocker: true,
  banners: true,
  params: true,
  pip: true,
  speedKeys: true,
  linkPreview: true,
  sitesOff: [],
};

export const SETTINGS_KEY = "settings";

/** Hostnames as Chrome stores them: lowercase ASCII, no port, no trailing dot. */
export function normalizeHost(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  try {
    const host = new URL(text.includes("://") ? text : `http://${text}`).hostname.replace(/\.$/, "");
    return /^[a-z0-9.-]+$/.test(host) && host.includes(".") || host === "localhost" || host.endsWith(".localhost") ? host : null;
  } catch {
    return null;
  }
}

/** Accepts anything read from storage and returns valid settings, falling back to defaults field by field. */
export function sanitizeSettings(raw: unknown): Settings {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const flags = Object.fromEntries(
    FEATURES.map(({ id }) => [id, typeof value[id] === "boolean" ? value[id] : DEFAULT_SETTINGS[id]]),
  ) as Record<Feature, boolean>;
  const sites = Array.isArray(value.sitesOff) ? value.sitesOff : [];
  const sitesOff = [...new Set(sites.filter((s): s is string => typeof s === "string").map(normalizeHost).filter((h): h is string => !!h))].sort();
  return { ...flags, sitesOff };
}

export function withSiteProtection(settings: Settings, host: string, on: boolean): Settings {
  const sitesOff = on ? settings.sitesOff.filter((h) => h !== host) : [...new Set([...settings.sitesOff, host])].sort();
  return { ...settings, sitesOff };
}

/** True when protections are off for this host or a parent domain the user listed. */
export function isSiteOff(settings: Settings, host: string): boolean {
  return settings.sitesOff.some((off) => host === off || host.endsWith(`.${off}`));
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: sanitizeSettings(settings) });
}
