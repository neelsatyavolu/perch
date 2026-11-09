/**
 * Fills a one-time code for perchd's agent. The agent names a tab and a frame URL; the extension
 * picks the account whose site matches that frame (the same rule as the panel's Fill button),
 * makes the code and types it into that frame. The answer is only "filled", "no-code" or
 * "no-field", so the code never leaves the extension.
 */

import { browserVault } from "./stores";
import { fillOneTimeCode, siteMatches } from "./site-fill";
import { codeFor, type VaultEntry } from "./vault";

export type FillResult = "filled" | "no-code" | "no-field";
export type Frame = { readonly frameId: number; readonly documentId: string; readonly url: string };

export type FillDeps = {
  /** The saved accounts, or null when the authenticator is off. */
  entries(): Promise<readonly VaultEntry[] | null>;
  frames(tabId: number): Promise<readonly Frame[]>;
  code(entry: VaultEntry): Promise<string>;
  fill(tabId: number, frame: Frame, code: string, host: string): Promise<boolean>;
};

export async function fillCodeInFrame(tabId: number, frameUrl: string, deps: FillDeps = chromeFillDeps): Promise<FillResult> {
  if (!Number.isInteger(tabId)) throw new TypeError("tabId must be an integer");
  const target = webUrl(frameUrl);
  const entries = await deps.entries().catch(() => null);
  const entry = accountFor(entries ?? [], target.hostname);
  if (!entry) return "no-code";
  const frame = frameFor(await deps.frames(tabId).catch(() => []), target);
  if (!frame) return "no-field";
  // Same origin as the target, so the frame's host is the one the account matched.
  const host = new URL(frame.url).hostname;
  const filled = await deps.fill(tabId, frame, await deps.code(entry), host).catch(() => false);
  return filled ? "filled" : "no-field";
}

function webUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("frameUrl must be a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("frameUrl must be an http(s) URL");
  return url;
}

/** The one account for this host; the most specific site wins, and a tie is no answer rather than a guess. */
function accountFor(entries: readonly VaultEntry[], host: string): VaultEntry | null {
  const matching = entries.filter((e) => siteMatches(e.site, host));
  const longest = Math.max(0, ...matching.map((e) => e.site!.length));
  const best = matching.filter((e) => e.site!.length === longest);
  return best.length === 1 ? best[0]! : null;
}

/** The frame with exactly this URL, else the first frame of the same origin; never another origin. */
function frameFor(frames: readonly Frame[], target: URL): Frame | null {
  const sameOrigin = frames.filter((f) => originOf(f.url) === target.origin);
  return sameOrigin.find((f) => f.url === target.href) ?? sameOrigin[0] ?? null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const chromeFillDeps: FillDeps = {
  entries: async () => {
    const open = await browserVault();
    return open ? open.vault.list() : null;
  },
  // Asks each frame for its address only; the code goes to one frame, by document id, afterwards.
  frames: async (tabId) => {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href });
    return results.filter((r) => typeof r.result === "string").map((r) => ({ frameId: r.frameId, documentId: r.documentId, url: r.result as string }));
  },
  code: (entry) => codeFor(entry),
  fill: async (tabId, frame, code, host) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId, documentIds: [frame.documentId] }, func: fillOneTimeCode, args: [code, host] });
    return result?.result === true;
  },
};
