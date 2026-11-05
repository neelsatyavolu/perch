/**
 * Downloads EasyList and EasyPrivacy into extension/.cache/lists. The build compiles whatever is
 * there, so a release build runs this first and records each list's hash in rules/meta.json.
 * EasyList and EasyPrivacy are dual-licensed GPLv3 / CC BY-SA 3.0 (https://easylist.to).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LISTS = {
  easylist: "https://easylist.to/easylist/easylist.txt",
  easyprivacy: "https://easylist.to/easylist/easyprivacy.txt",
} as const;

export const CACHE_DIR = join(import.meta.dir, "..", ".cache", "lists");

const MAX_BYTES = 20 * 1024 * 1024;

export async function downloadLists(dir = CACHE_DIR): Promise<Record<string, string>> {
  mkdirSync(dir, { recursive: true });
  const paths: Record<string, string> = {};
  for (const [id, url] of Object.entries(LISTS)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${id}: download failed with HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(`${id}: list is larger than ${MAX_BYTES} bytes`);
    if (!text.startsWith("[Adblock Plus")) throw new Error(`${id}: response is not an Adblock Plus filter list`);
    const path = join(dir, `${id}.txt`);
    writeFileSync(path, text);
    paths[id] = path;
  }
  return paths;
}

if (import.meta.main) {
  const paths = await downloadLists();
  for (const [id, path] of Object.entries(paths)) process.stdout.write(`${id}: ${path}\n`);
}
