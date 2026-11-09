/** Site facts for the panel: blocked counts, permissions, cookies. Runs in the extension's pages. */

import { isBlockRuleId } from "../rules/limits";

export type Counts = { blocked: number; params: number };

/** Requests blocked and parameters removed since the page in this tab started loading. */
export async function matchedCounts(tabId: number): Promise<Counts> {
  let since = 0;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => performance.timeOrigin });
    if (typeof res?.result === "number") since = res.result - 1_000;
  } catch {
    // Pages Perch cannot script (the Web Store, PDFs) still get counts for the tab's life.
  }
  const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId, minTimeStamp: since });
  let blocked = 0;
  let params = 0;
  for (const { rule } of rulesMatchedInfo) {
    if (rule.rulesetId === "params") params++;
    else if ((rule.rulesetId === "easylist" || rule.rulesetId === "easyprivacy") && isBlockRuleId(rule.ruleId)) blocked++;
  }
  return { blocked, params };
}

export type PermissionId = "camera" | "microphone" | "location" | "notifications" | "popups" | "javascript";
export type PermissionValue = "allow" | "block" | "ask";

export const PERMISSIONS: readonly { id: PermissionId; label: string; canAsk: boolean }[] = [
  { id: "camera", label: "Camera", canAsk: true },
  { id: "microphone", label: "Microphone", canAsk: true },
  { id: "location", label: "Location", canAsk: true },
  { id: "notifications", label: "Notifications", canAsk: true },
  { id: "popups", label: "Pop-ups and redirects", canAsk: false },
  { id: "javascript", label: "JavaScript", canAsk: false },
];

type Setting = { get(d: { primaryUrl: string }): Promise<{ setting: string }>; set(d: { primaryPattern: string; setting: string }): Promise<void> };

function setting(id: PermissionId): Setting {
  return chrome.contentSettings[id] as unknown as Setting;
}

export async function permission(id: PermissionId, url: string): Promise<PermissionValue> {
  const { setting: value } = await setting(id).get({ primaryUrl: url });
  return value === "allow" || value === "block" ? value : "ask";
}

export async function setPermission(id: PermissionId, url: string, value: PermissionValue): Promise<void> {
  const { protocol, hostname } = new URL(url);
  await setting(id).set({ primaryPattern: `${protocol}//${hostname}/*`, setting: value });
}

export async function cookieCount(url: string): Promise<number> {
  return (await chrome.cookies.getAll({ url })).length;
}

/** Clears the site's cookies and storage. Chrome widens cookie removal to the registrable domain. */
export async function forgetSite(url: string): Promise<void> {
  const { origin } = new URL(url);
  await chrome.browsingData.remove(
    { origins: [origin] },
    { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true },
  );
}
