/**
 * Installed extensions as a list to reinstall. Only the manifest is read; extension code and
 * storage stay behind. Extensions from the Chrome Web Store get a store link Perch can open.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Extension } from "../types";

const ID = /^[a-p]{32}$/;
const WEB_STORE_UPDATE = "clients2.google.com/service/update2/crx";

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function json(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function newest(versions: string[]): string | undefined {
  const parse = (v: string) => v.split(/[._]/).map((n) => Number(n) || 0);
  return [...versions].sort((a, b) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  })[0];
}

/** "__MSG_appName__" names come from _locales/<default_locale>/messages.json. */
function displayName(dir: string, manifest: any): string {
  const raw = typeof manifest?.name === "string" ? manifest.name : "";
  const msg = /^__MSG_(\w+)__$/.exec(raw);
  if (!msg) return raw;
  const locale = typeof manifest.default_locale === "string" && /^[\w-]+$/.test(manifest.default_locale) ? manifest.default_locale : "en";
  const messages = json(join(dir, "_locales", locale, "messages.json")) ?? {};
  const wanted = msg[1]!.toLowerCase();
  const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === wanted)?.[1] as { message?: string } | undefined;
  return hit?.message ?? raw;
}

export function readChromeExtensions(profile: string): Extension[] {
  const root = join(profile, "Extensions");
  return list(root)
    .filter((id) => ID.test(id))
    .flatMap((id): Extension[] => {
      const version = newest(list(join(root, id)).filter((v) => /^[\d._]+$/.test(v)));
      if (!version) return [];
      const dir = join(root, id, version);
      const manifest = json(join(dir, "manifest.json"));
      if (!manifest) return [];
      const fromStore = typeof manifest.update_url === "string" && manifest.update_url.includes(WEB_STORE_UPDATE);
      return [{ id, name: displayName(dir, manifest) || id, version: String(manifest.version ?? version), ...(fromStore ? { storeUrl: `https://chromewebstore.google.com/detail/${id}` } : {}) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
