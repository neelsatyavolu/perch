/** What happened in each tab that the panel reports, kept in session storage (memory only, gone on restart). */

export type TabState = { banner: { cmp: string; url: string; at: number } | null };

const key = (tabId: number) => `tab:${tabId}`;

export async function recordBanner(tabId: number, url: string, cmp: string): Promise<void> {
  await chrome.storage.session.set({ [key(tabId)]: { banner: { cmp, url, at: Date.now() } } satisfies TabState });
}

export async function tabState(tabId: number): Promise<TabState> {
  const value = (await chrome.storage.session.get(key(tabId)))[key(tabId)] as TabState | undefined;
  return value ?? { banner: null };
}

export async function forgetTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(key(tabId));
}
