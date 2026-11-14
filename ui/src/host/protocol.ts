/** The messages between a chat frame and Perch's trusted shell around it. Shared by both sides. */

export const HOST_REQUEST = "perch-host";
export const HOST_REPLY = "perch-host-reply";
export const HOST_EVENT = "perch-host-event";

/** The trusted shells that frame the chat pages. */
export const SHELL_ORIGINS: readonly string[] = ["chrome://perch-chat", "chrome://perch-side-chat.top-chrome"];
/** The untrusted chat pages a shell frames. */
export const FRAME_ORIGINS: readonly string[] = ["chrome-untrusted://perch-chat", "chrome-untrusted://perch-side-chat.top-chrome"];

/** Every call a frame may make. The shell relays these and nothing else. */
export const HOST_METHODS = ["close", "openTab", "openFullChat", "openSettings", "getAppearance", "chooseFiles", "pastedFiles", "startDictation", "stopDictation", "setTabState"] as const;
export type HostMethod = (typeof HOST_METHODS)[number];

/** A file the user attached, as the page sees it: an opaque id, never a path. */
export type AttachedFile = { id: string; name: string; size: number };

/** Addresses a frame may open in a tab: web pages and artifacts, never browser pages or files. */
export function openableUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "perch-artifact:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A chat id the shell may pass on to the browser (letters, digits, - and _). */
export function chatIdArg(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
}

/** The Appearance settings, as the browser sends them (ui-pages/src/api.ts Appearance). */
export type HostAppearance = { theme: string; accent: string; matchSystem: boolean; darkTheme: string };

export function isAppearance(v: unknown): v is HostAppearance {
  const o = v as Partial<HostAppearance> | null;
  return typeof o?.theme === "string" && typeof o.accent === "string" && typeof o.matchSystem === "boolean" && typeof o.darkTheme === "string";
}
