/** Fetches what a link's page says about itself, for the hover card. No cookies are sent. */

import { stripTrackingParams } from "../params/strip";
import { mayPreview, parseMeta, type PreviewMeta } from "../preview/meta";

export type Preview = PreviewMeta & { url: string; kind: "page" | "file" };

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 6_000;
const CACHE_MS = 5 * 60_000;
const CACHE_SIZE = 50;
const cache = new Map<string, { at: number; preview: Preview }>();

export async function fetchPreview(linkUrl: string, pageUrl: string): Promise<Preview> {
  const url = stripTrackingParams(linkUrl);
  if (!mayPreview(pageUrl, url)) throw new Error("Perch does not preview links to this kind of address.");
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.preview;

  const res = await fetch(url, {
    credentials: "omit",
    redirect: "follow",
    referrerPolicy: "no-referrer",
    headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const finalUrl = stripTrackingParams(res.url || url);
  if (!mayPreview(pageUrl, finalUrl)) throw new Error("Perch does not preview links to this kind of address.");
  if (!res.ok) throw new Error(`The site answered with an error (${res.status}).`);

  const type = res.headers.get("content-type") ?? "";
  const preview: Preview = type.includes("html")
    ? { ...parseMeta(await readStart(res), finalUrl), url: finalUrl, kind: "page" }
    : fileCard(finalUrl, type, res);
  remember(url, preview);
  return preview;
}

function fileCard(url: string, type: string, res: Response): Preview {
  void res.body?.cancel();
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || new URL(url).hostname);
  const size = Number(res.headers.get("content-length"));
  const detail = [type.split(";")[0], Number.isFinite(size) && size > 0 ? formatBytes(size) : ""].filter(Boolean).join(", ");
  return { title: name, description: detail || null, image: null, siteName: new URL(url).hostname, url, kind: "file" };
}

async function readStart(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
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
  return new TextDecoder().decode(bytes.subarray(0, MAX_BYTES));
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
