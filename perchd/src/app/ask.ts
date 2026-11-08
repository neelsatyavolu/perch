/**
 * Ask (spec 5.5): ⌘↵ in the address bar and the new tab page's Ask button. The browser sends
 * `Perch.askRequested({text, tabId})`; the task starts in that tab's side chat, or in a new
 * full-page chat when there is no tab, and the browser shows it (`Perch.revealChat`).
 */

import type { AskRequest, PerchDomainApi } from "../browser/perch-domain";
import type { ChatStore } from "./chats";
import type { ChatSettings, TabInfo } from "./protocol";
import type { RunManager } from "./runs";

export type AskDeps = {
  chats: ChatStore;
  runs: RunManager;
  /** The tabs the browser reported (Windows.tab). */
  tab: (tabId: string) => TabInfo | undefined;
  defaults: () => ChatSettings;
  perch: Pick<PerchDomainApi, "revealChat">;
};

export type AskResult = { chatId: string; started: boolean };

export async function askFromBrowser(deps: AskDeps, ask: AskRequest): Promise<AskResult> {
  const tab = ask.tabId ? deps.tab(ask.tabId) : undefined;
  const chat = tab
    ? deps.chats.forTab(tab.id) ?? (await deps.chats.create({ tab: { id: tab.id, windowId: tab.windowId }, settings: deps.defaults() }))
    : await deps.chats.create({ settings: deps.defaults() });
  deps.runs.announce(chat.id);
  await deps.perch.revealChat({ chatId: chat.id, mode: tab ? "side" : "full", ...(tab ? { tabId: tab.id } : {}) }).catch(() => null);
  // A task already going in this side chat keeps going; the user sees it and can ask again after.
  if (deps.runs.status(chat.id) !== "idle") return { chatId: chat.id, started: false };
  await deps.runs.send(chat.id, ask.text, tab);
  return { chatId: chat.id, started: true };
}
