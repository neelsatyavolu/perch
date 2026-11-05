/** Context menus and keyboard commands. */

import { stripTrackingParams } from "../params/strip";
import { pictureInPicture, setPlaybackRate } from "../media/inject";
import { fullPageScreenshot } from "./screenshot";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3] as const;

export function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "copy-clean", title: "Copy link without tracking", contexts: ["link"] });
    chrome.contextMenus.create({ id: "reader", title: "Reader view", contexts: ["page"] });
    chrome.contextMenus.create({ id: "screenshot", title: "Full-page screenshot", contexts: ["page"] });
    chrome.contextMenus.create({ id: "pip", title: "Picture in picture", contexts: ["video"] });
    chrome.contextMenus.create({ id: "speed", title: "Playback speed", contexts: ["video"] });
    for (const rate of SPEEDS) {
      chrome.contextMenus.create({ id: `speed:${rate}`, parentId: "speed", title: rate === 1 ? "Normal" : `${rate}×`, contexts: ["video"] });
    }
  });
}

export async function onMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const id = String(info.menuItemId);
  if (id === "copy-clean" && info.linkUrl) return copyText(stripTrackingParams(info.linkUrl));
  if (id === "reader") return toggleReader(tabId);
  if (id === "screenshot") return void (await fullPageScreenshot(tabId));
  if (id === "pip") return pictureInPicture(tabId);
  if (id.startsWith("speed:")) {
    const rate = Number(id.slice("speed:".length));
    if (!(SPEEDS as readonly number[]).includes(rate)) return;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [info.frameId ?? 0] }, func: setPlaybackRate, args: [info.srcUrl ?? "", rate] });
  }
}

export async function onCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (tabId === undefined) return;
  if (command === "screenshot") await fullPageScreenshot(tabId);
  if (command === "reader") await toggleReader(tabId);
  if (command === "pip") await pictureInPicture(tabId);
}

export async function toggleReader(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/reader.js"] });
}

/** Copies through an offscreen document, so the page never sees the text or a copy event. */
export async function copyText(text: string): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Copy a link without its tracking parameters.",
    });
  }
  await chrome.runtime.sendMessage({ target: "offscreen", type: "copy", text });
}
