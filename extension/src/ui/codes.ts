/** QR import and code fill for the authenticator. */

import { codeFor, type VaultEntry } from "../totp/vault";

/** A code fills only on its site or that site's subdomains; anywhere else it can only be copied. */
export function siteMatches(site: string | null, host: string): boolean {
  if (!site) return false;
  return host === site || host.endsWith(`.${site}`);
}

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

// Runs inside the page.
function fillOneTimeCode(code: string, expectedHost: string): boolean {
  if (location.hostname !== expectedHost) return false;
  const isField = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement && !el.disabled && !el.readOnly && ["text", "tel", "number", "password", ""].includes(el.type);
  const candidates = [
    document.activeElement,
    document.querySelector('input[autocomplete="one-time-code"]'),
    document.querySelector('input[name*="otp" i], input[name*="totp" i], input[id*="otp" i], input[name*="code" i][inputmode="numeric"]'),
  ];
  const field = candidates.find(isField);
  if (!field) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, code);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
