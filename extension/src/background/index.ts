/** The service worker: applies settings, answers validated messages, and runs menus and commands. */

import { parseContentMessage, parsePageMessage, senderOrigin, type ContentMessage, type PageMessage } from "../shared/messages";
import { SETTINGS_KEY, isSiteOff, loadSettings } from "../shared/settings";
import { createMenus, onCommand, onMenuClick, toggleReader } from "./menus";
import { fetchPreview } from "./preview";
import { applySettings } from "./protection";
import { fullPageScreenshot } from "./screenshot";
import { forgetTab, recordBanner, tabState } from "./tabstate";

async function setUp(): Promise<void> {
  createMenus();
  await applySettings(await loadSettings());
}

chrome.runtime.onInstalled.addListener(() => void setUp().catch(report));
chrome.runtime.onStartup.addListener(() => void setUp().catch(report));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) void loadSettings().then(applySettings).catch(report);
});

chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));
chrome.contextMenus.onClicked.addListener((info, tab) => void onMenuClick(info, tab).catch(report));
chrome.commands.onCommand.addListener((command, tab) => void onCommand(command, tab).catch(report));

chrome.runtime.onMessage.addListener((raw, sender, reply) => {
  if ((raw as { target?: string } | null)?.target === "offscreen") return false;
  const origin = senderOrigin(sender, chrome.runtime.id);
  const work =
    origin === "content" ? handleContent(parseContentMessage(raw), sender) : origin === "page" ? handlePage(parsePageMessage(raw)) : null;
  if (!work) return false;
  work.then(
    (value) => reply({ ok: true, value }),
    (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

function handleContent(message: ContentMessage | null, sender: chrome.runtime.MessageSender): Promise<unknown> | null {
  const tab = sender.tab;
  if (!message || !tab?.id || !sender.url) return null;
  switch (message.type) {
    case "banner":
      return reportBanner(tab.id, tab.url ?? sender.url, message.cmp);
    case "banner-allowed":
      return bannersAllowed(tab.url);
    case "preview":
      return fetchPreview(message.url, sender.url);
    case "open":
      // Without windowId Chrome uses the focused window, which need not be the page's, and rejects the opener.
      return chrome.tabs.create({ url: message.url, windowId: tab.windowId, index: tab.index + 1, openerTabId: tab.id, active: true }).then(() => null);
  }
}

function handlePage(message: PageMessage | null): Promise<unknown> | null {
  if (!message) return null;
  switch (message.type) {
    case "screenshot":
      return fullPageScreenshot(message.tabId);
    case "reader":
      return toggleReader(message.tabId);
    case "tab-state":
      return tabState(message.tabId);
  }
}

async function reportBanner(tabId: number, url: string, cmp: string): Promise<void> {
  const host = new URL(url).hostname;
  // A frame on an exempt site could still report; keep the record honest.
  if (isSiteOff(await loadSettings(), host)) return;
  await recordBanner(tabId, url, cmp);
}

/**
 * Frames ask before handling a banner: the exemption list is matched against each frame's own URL,
 * so a consent frame from another origin (Sourcepoint, TrustArc) inside an exempt site would
 * otherwise still act. Without the tab's address, the answer is no.
 */
async function bannersAllowed(tabUrl: string | undefined): Promise<boolean> {
  if (!tabUrl) return false;
  const host = new URL(tabUrl).hostname;
  return !isSiteOff(await loadSettings(), host);
}

function report(error: unknown): void {
  console.error("Perch extension:", error);
}
