/**
 * Every message the service worker accepts, validated in one place. Content scripts run next to
 * untrusted pages, so they may only report a banner result and ask for a link preview; anything
 * that touches captures, tabs or settings must come from the extension's own pages.
 */

import { CMP_NAMES } from "../banners/rules";

export type ContentMessage =
  | { type: "banner"; cmp: string }
  | { type: "preview"; url: string }
  | { type: "open"; url: string };

export type PageMessage =
  | { type: "screenshot"; tabId: number }
  | { type: "reader"; tabId: number }
  | { type: "tab-state"; tabId: number };

export type Origin = "content" | "page";

const MAX_URL = 8192;

export function senderOrigin(sender: { id?: string; url?: string; tab?: unknown }, extensionId: string): Origin | null {
  if (sender.id !== extensionId) return null;
  if (sender.url?.startsWith(`chrome-extension://${extensionId}/`)) return "page";
  return sender.tab ? "content" : null;
}

export function parseContentMessage(raw: unknown): ContentMessage | null {
  const m = asRecord(raw);
  if (!m) return null;
  switch (m.type) {
    case "banner":
      return typeof m.cmp === "string" && CMP_NAMES.includes(m.cmp) ? { type: "banner", cmp: m.cmp } : null;
    case "preview":
    case "open": {
      const url = webUrl(m.url);
      return url ? { type: m.type, url } : null;
    }
    default:
      return null;
  }
}

export function parsePageMessage(raw: unknown): PageMessage | null {
  const m = asRecord(raw);
  if (!m) return null;
  if (m.type !== "screenshot" && m.type !== "reader" && m.type !== "tab-state") return null;
  return Number.isSafeInteger(m.tabId) && (m.tabId as number) >= 0 ? { type: m.type, tabId: m.tabId as number } : null;
}

/** An absolute http(s) URL of sane length, or null. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}
