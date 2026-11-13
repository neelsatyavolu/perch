/**
 * Site-specific element hiding. Each committed frame gets the hides its host and parent domains
 * call for (plus generic selectors some other site excepts), as a user stylesheet the page cannot
 * override. Generic hides are the static content script in plan.ts.
 */

import { EMPTY_COSMETIC, sanitizeCosmetic, siteCss, type CosmeticData } from "../cosmetic/data";
import { isSiteOff, loadSettings } from "../shared/settings";

let data: Promise<CosmeticData> | null = null;

/** sites.json, read once per service worker life. A failed read is retried next time. */
export function cosmeticData(): Promise<CosmeticData> {
  data ??= fetch(chrome.runtime.getURL("cosmetic/sites.json"))
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`cosmetic/sites.json: HTTP ${res.status}`))))
    .then(sanitizeCosmetic)
    .catch((error: unknown) => {
      data = null;
      console.error("Perch extension: element hiding data unavailable:", error);
      return EMPTY_COSMETIC;
    });
  return data;
}

type Committed = chrome.webNavigation.WebNavigationTransitionCallbackDetails;

export async function hideOnCommit(details: Committed): Promise<void> {
  if (!/^https?:/.test(details.url)) return;
  const settings = await loadSettings();
  if (!settings.blocker) return;
  const host = new URL(details.url).hostname;
  const top = await topHost(details);
  // Without the tab's address there is no telling whether the user exempted it: do nothing.
  if (top === null || isSiteOff(settings, top) || isSiteOff(settings, host)) return;
  const css = siteCss(await cosmeticData(), host);
  if (!css) return;
  const target = details.documentId ? { tabId: details.tabId, documentIds: [details.documentId] } : { tabId: details.tabId, frameIds: [details.frameId] };
  try {
    await chrome.scripting.insertCSS({ target, css, origin: "USER" });
  } catch (error) {
    // The frame went away or is one Chrome will not let extensions touch (error pages, the Web Store).
    console.debug("Perch extension: element hiding skipped:", error);
  }
}

/** The host of the frame's outermost page, walking up through parent documents (prerendered pages included). */
async function topHost(details: Committed): Promise<string | null> {
  if (details.parentFrameId === -1) return new URL(details.url).hostname;
  let parent = details.parentDocumentId;
  for (let depth = 0; parent && depth < 32; depth++) {
    const frame = await chrome.webNavigation.getFrame({ documentId: parent }).catch(() => null);
    if (!frame) return null;
    if (frame.parentFrameId === -1) return hostOf(frame.url);
    parent = frame.parentDocumentId;
  }
  if (parent) return null;
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  return hostOf(tab?.url);
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}
