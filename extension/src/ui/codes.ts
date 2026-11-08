/** QR import and code fill for the authenticator. */

import { fillOneTimeCode, siteMatches } from "../totp/site-fill";
import { codeFor, type VaultEntry } from "../totp/vault";

export { siteMatches };

/** Captures the visible part of the tab and reads the first otpauth:// QR code in it. */
export async function scanTabForSetupCode(tab: chrome.tabs.Tab): Promise<string> {
  if (!tab.active) await chrome.tabs.update(tab.id!, { active: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const codes = await detector.detect(bitmap);
    const setup = codes.map((c) => c.rawValue).find((v) => v.startsWith("otpauth://"));
    if (setup) return setup;
    throw new Error(codes.length ? "The QR code on this page is not an authenticator setup code." : "No QR code is visible on this page. Scroll it into view and try again.");
  } finally {
    bitmap.close();
  }
}

/**
 * Types the current code into the page's one-time-code field. The code goes only to the main
 * frame, and only when the tab is still on the account's site at the moment of filling.
 */
export async function fillCode(tabId: number, entry: VaultEntry): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const host = tab.url ? new URL(tab.url).hostname : "";
  if (!siteMatches(entry.site, host)) throw new Error(`This code fills only on ${entry.site ?? "the site it was added from"}.`);
  const code = await codeFor(entry);
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: fillOneTimeCode, args: [code, host] });
  if (result?.result !== true) throw new Error("No code field found on this page. Click into the field, then try Fill again.");
}
