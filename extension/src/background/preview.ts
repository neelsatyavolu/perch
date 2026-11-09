/**
 * Fetches what a link's page says about itself, for the hover card. No cookies are sent.
 *
 * The worker has <all_urls> host access, so its fetches skip CORS and Chrome's local-network
 * checks. Every preview fetch for a public page therefore runs under a session rule that blocks
 * this extension's own background requests to private addresses, which also covers each redirect
 * hop (fetch cannot show them: a manual redirect is opaque). The card's image is fetched here too
 * and handed over as a data: URL, so the page never makes the request or sees its timing.
 */

import { stripTrackingParams } from "../params/strip";
import { PRIVATE_URL_PATTERNS, isPrivateHost, mayPreview, parseMeta, type PreviewMeta } from "../preview/meta";

export type Preview = PreviewMeta & { url: string; kind: "page" | "file" };

const MAX_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;
const TIMEOUT_MS = 6_000;
const IMAGE_TIMEOUT_MS = 4_000;
/** Session rule ids for the network guard; nothing else in the extension uses session rules. */
const GUARD_RULE_BASE = 1_000;
const REFUSED = "Perch does not preview links to this kind of address.";
const CACHE_MS = 5 * 60_000;
const CACHE_SIZE = 50;
const cache = new Map<string, { at: number; preview: Preview }>();

export async function fetchPreview(linkUrl: string, pageUrl: string): Promise<Preview> {
  const url = stripTrackingParams(linkUrl);
  if (!mayPreview(pageUrl, url)) throw new Error(REFUSED);
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.preview;
  const preview = await guarded(!isPrivateHost(new URL(pageUrl).hostname), () => load(url, pageUrl));
  remember(url, preview);
  return preview;
}

async function load(url: string, pageUrl: string): Promise<Preview> {
  const res = await fetch(url, {
    credentials: "omit",
    redirect: "follow",
    referrerPolicy: "no-referrer",
    headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    throw new Error("The link could not be reached, or it leads to an address Perch does not preview.");
  });
  const finalUrl = stripTrackingParams(res.url || url);
  if (!mayPreview(pageUrl, finalUrl)) {
    void res.body?.cancel();
    throw new Error(REFUSED);
  }
  if (!res.ok) throw new Error(`The site answered with an error (${res.status}).`);

  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("html")) return fileCard(finalUrl, type, res);
  const meta = parseMeta(new TextDecoder().decode(await readStart(res, MAX_BYTES)), finalUrl);
  const image = meta.image && mayPreview(pageUrl, meta.image) ? await loadImage(meta.image) : null;
  return { ...meta, image, url: finalUrl, kind: "page" };
}

/** The image as a data: URL, or null when it is missing, too large or not a plain raster image. */
async function loadImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES.test(type)) {
      void res.body?.cancel();
      return null;
    }
    const bytes = await readStart(res, MAX_IMAGE_BYTES + 1);
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b);
    return `data:${type};base64,${btoa(text)}`;
  } catch {
    return null;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs preview fetches one at a time, with the private-address guard on unless the page is itself
 * on a private network (an intranet page may preview its own links).
 */
function guarded<T>(on: boolean, work: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    await setGuard(on);
    return work();
  });
  queue = run.catch(() => undefined);
  return run;
}

async function setGuard(on: boolean): Promise<void> {
  const ids = PRIVATE_URL_PATTERNS.map((_, i) => GUARD_RULE_BASE + i);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids, addRules: on ? guardRules(chrome.runtime.id) : [] });
}

/** Blocks this extension's own requests that belong to no tab (the worker's fetches) to private addresses. */
export function guardRules(extensionId: string): chrome.declarativeNetRequest.Rule[] {
  return PRIVATE_URL_PATTERNS.map((regexFilter, i) => ({
    id: GUARD_RULE_BASE + i,
    priority: 1_000,
    action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
    condition: { regexFilter, isUrlFilterCaseSensitive: false, initiatorDomains: [extensionId], tabIds: [-1] },
  }));
}

function fileCard(url: string, type: string, res: Response): Preview {
  void res.body?.cancel();
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || new URL(url).hostname);
  const size = Number(res.headers.get("content-length"));
  const detail = [type.split(";")[0], Number.isFinite(size) && size > 0 ? formatBytes(size) : ""].filter(Boolean).join(", ");
  return { title: name, description: detail || null, image: null, siteName: new URL(url).hostname, url, kind: "file" };
}

async function readStart(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  void reader.cancel();
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes.subarray(0, limit);
}

function remember(url: string, preview: Preview): void {
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(url, { at: Date.now(), preview });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
