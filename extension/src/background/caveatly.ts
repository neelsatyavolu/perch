/**
 * Caveatly, built into Perch, blocks ads with its own lists alongside Perch's. Perch's blocker
 * settings stay the one place to control blocking: whenever they change, and whenever Caveatly
 * starts and asks, this sends Caveatly the master switch and the sites protections are off for.
 * Caveatly only takes these messages from this extension (its caveatly_embed.controller) and
 * hides its own switches inside Perch.
 */

import type { Settings } from "../shared/settings";

export const CAVEATLY_ID = "mefnjppdmliabfgljepbdgdalmgggmid";

export type BlockerState = { readonly type: "perch.blocker"; readonly on: boolean; readonly sitesOff: readonly string[] };

export function blockerState(settings: Settings): BlockerState {
  return { type: "perch.blocker", on: settings.blocker, sitesOff: [...settings.sitesOff] };
}

/** Tells Caveatly; it may be off in Settings or still starting, which is fine: it asks when it starts. */
export async function syncCaveatly(settings: Settings, send: typeof chrome.runtime.sendMessage = chrome.runtime.sendMessage): Promise<void> {
  try {
    await send(CAVEATLY_ID, blockerState(settings));
  } catch {
    // Not running: it asks for the state with "caveatly.ready" when it starts.
  }
}

/** Caveatly's "caveatly.ready" when it starts: answered with the current state. Anyone else is ignored. */
export function isCaveatlyAsking(raw: unknown, sender: chrome.runtime.MessageSender): boolean {
  return sender.id === CAVEATLY_ID && (raw as { type?: unknown } | null)?.type === "caveatly.ready";
}
