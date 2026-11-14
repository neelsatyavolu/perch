/**
 * Each browser's own app icon, for the import list: read from the app on this Mac (its .icns,
 * turned into a small PNG with macOS's sips), never shipped with Perch. Missing apps, or apps
 * whose icon is only in an asset catalog, get no icon and the page shows a letter instead.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The app names each browser installs as. */
const APPS: Readonly<Record<string, readonly string[]>> = {
  aside: ["Aside"], chrome: ["Google Chrome"], "chrome-beta": ["Google Chrome Beta"], "chrome-canary": ["Google Chrome Canary"],
  arc: ["Arc"], dia: ["Dia"], comet: ["Comet"], atlas: ["ChatGPT Atlas"], brave: ["Brave Browser"], edge: ["Microsoft Edge"],
  vivaldi: ["Vivaldi"], opera: ["Opera"], "opera-gx": ["Opera GX"], helium: ["Helium"], chromium: ["Chromium"],
  safari: ["Safari"], firefox: ["Firefox"], zen: ["Zen", "Zen Browser"],
};
const SIZE = 64;
const cache = new Map<string, string | null>();

function plistString(plist: string, key: string): string | undefined {
  const r = Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", `Print :${key}`, plist], { stdout: "pipe", stderr: "ignore" });
  const out = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  return out || undefined;
}

function iconFile(app: string): string | undefined {
  const plist = join(app, "Contents", "Info.plist");
  const name = plistString(plist, "CFBundleIconFile") ?? plistString(plist, "CFBundleIconName");
  if (!name) return undefined;
  const file = join(app, "Contents", "Resources", name.endsWith(".icns") ? name : `${name}.icns`);
  return existsSync(file) ? file : undefined;
}

function toPng(icns: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "perch-icon-"));
  try {
    const out = join(dir, "icon.png");
    const r = Bun.spawnSync(["/usr/bin/sips", "-s", "format", "png", "-Z", String(SIZE), icns, "--out", out], { stdout: "ignore", stderr: "ignore" });
    return r.exitCode === 0 && existsSync(out) ? `data:image/png;base64,${readFileSync(out).toString("base64")}` : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A data: URL of the browser's icon, or undefined. Looked up once per browser while perchd runs. */
export function browserIcon(browser: string, home: string): string | undefined {
  if (!cache.has(browser)) {
    const app = (APPS[browser] ?? [])
      .flatMap((name) => [join("/Applications", `${name}.app`), join(home, "Applications", `${name}.app`)])
      .find((p) => existsSync(p));
    const file = app ? iconFile(app) : undefined;
    cache.set(browser, file ? toPng(file) : null);
  }
  return cache.get(browser) ?? undefined;
}
