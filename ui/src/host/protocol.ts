/** The messages between a chat frame and Perch's trusted shell around it. Shared by both sides. */

export const HOST_REQUEST = "perch-host";
export const HOST_REPLY = "perch-host-reply";
export const HOST_EVENT = "perch-host-event";

/** The trusted shells that frame the chat pages. */
export const SHELL_ORIGINS: readonly string[] = ["chrome://perch-chat", "chrome://perch-side-chat"];
/** The untrusted chat pages a shell frames. */
export const FRAME_ORIGINS: readonly string[] = ["chrome-untrusted://perch-chat", "chrome-untrusted://perch-side-chat"];

/** Every call a frame may make. The shell relays these and nothing else. */
export const HOST_METHODS = ["close", "openTab", "chooseFiles", "startDictation", "stopDictation"] as const;
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
