/**
 * Opening a page for the agent. Many real pages never fire their load event in reasonable time
 * (ads, trackers, long polls) though their content has been there for seconds; waiting the full
 * 30 s and then failing wastes a step. Once the document is parsed, the page is returned with a note.
 */

import type { Tab } from "../browser/tab";

/** How long to wait for the load event before settling for a parsed document. */
export const LOAD_WAIT_MS = 10_000;
/** How long, after that, to wait for a document that is still being parsed. */
const PARSE_WAIT_MS = 20_000;
const POLL_MS = 100;

export const STILL_LOADING = "The page is still loading, so parts of it may be missing. If something you need is not there, take a snapshot again in a moment.";

/** Navigates and returns a note for the model ("" when the page loaded normally). */
export async function openPage(tab: Tab, url: string, opts: { loadMs?: number; parseMs?: number } = {}): Promise<string> {
  try {
    await tab.navigate(url, { timeoutMs: opts.loadMs ?? LOAD_WAIT_MS });
    return "";
  } catch (error) {
    if (!/did not finish loading/.test(String(error))) throw error;
  }
  const deadline = Date.now() + (opts.parseMs ?? PARSE_WAIT_MS);
  while (Date.now() < deadline) {
    const state = await tab.evaluate<string>("document.readyState").catch(() => "loading");
    if (state !== "loading") return STILL_LOADING;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`${url} did not load; the site may be slow or down. Try again, or use another page`);
}
