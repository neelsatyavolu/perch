/**
 * Private chats (spec 5.8). A side chat opened in an incognito tab lives in memory only, runs
 * without memory, and is deleted, artifacts included, once the browser reports no private tab.
 */

import type { Windows } from "./app";
import type { ArtifactStore } from "./artifacts";
import type { ChatStore } from "./chats";
import { AppError, type RunManager } from "./runs";

type Stores = { chats: ChatStore; artifacts: ArtifactStore; runs: RunManager; windows: Windows };

/** Whether the browser said this tab is in a private window. Only its reports count. */
export function isPrivateTab(windows: Windows, tabId: string): boolean {
  return windows.tab(tabId)?.incognito === true;
}

/** A chat may only be the side chat of a tab of its own kind: private with private, normal with normal. */
export function checkSameKind(chat: { incognito?: true }, tabIsPrivate: boolean): void {
  if (Boolean(chat.incognito) === tabIsPrivate) return;
  throw new AppError(tabIsPrivate ? "A saved chat can't move into a private window" : "A private chat stays in its private window");
}

/** Deletes every private chat when no private tab is left. Returns the ids it removed. */
export async function endPrivateChats(s: Stores): Promise<string[]> {
  if (s.windows.tabs().some((t) => t.incognito)) return [];
  const ended = s.chats.privateChats().map((c) => c.id);
  for (const id of ended) {
    s.runs.cancel(id);
    await s.runs.idleFor(id);
    await s.artifacts.removeForChat(id);
    await s.chats.remove(id);
    s.runs.announceRemoved(id);
  }
  return ended;
}
