/**
 * Builds the unpacked extension into dist/: bundles the TypeScript, copies the static files and
 * icons, and compiles the filter lists into declarativeNetRequest rulesets.
 *
 *   bun scripts/build.ts            uses lists in .cache/lists, downloading them if missing
 *   bun scripts/build.ts --refresh  downloads fresh lists first
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { compileLists, type Rule } from "../src/rules/compile";
import { STATIC_RULE_BUDGET } from "../src/rules/limits";
import { paramRules } from "../src/params/strip";
import { CACHE_DIR, LISTS, downloadLists } from "./lists";

const ROOT = join(import.meta.dir, "..");
const ICONS = join(ROOT, "..", "overlay", "chrome", "app", "theme");

export type BuildOptions = {
  outDir?: string;
  /** Filter list files by ruleset id; defaults to the downloaded EasyList and EasyPrivacy. */
  lists?: Record<string, string>;
  minify?: boolean;
};

export type BuildReport = { outDir: string; rules: Record<string, number>; skipped: Record<string, Record<string, number>> };

const ESM_ENTRIES = ["src/background/index.ts", "src/ui/popup.ts", "src/ui/options.ts", "src/ui/shot.ts", "src/ui/offscreen.ts"];
const CONTENT_ENTRIES = ["src/content/banners.ts", "src/content/pip.ts", "src/content/speed.ts", "src/content/preview.ts", "src/content/reader.ts"];

export async function build(opts: BuildOptions = {}): Promise<BuildReport> {
  const outDir = opts.outDir ?? join(ROOT, "dist");
  const minify = opts.minify ?? true;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "rules"), { recursive: true });

  await bundle(ESM_ENTRIES, "esm", outDir, minify);
  // Content scripts are classic scripts: one self-contained file each, no imports at run time.
  await bundle(CONTENT_ENTRIES, "iife", outDir, minify);

  cpSync(join(ROOT, "static"), outDir, { recursive: true });
  copyIcons(join(outDir, "icons"));

  const lists = opts.lists ?? (await defaultLists());
  const compiled = compileLists(Object.entries(lists).map(([id, path]) => ({ id, text: readFileSync(path, "utf8") })), STATIC_RULE_BUDGET - 1);
  const rulesets: { id: string; rules: Rule[] }[] = [...compiled.rulesets, { id: "params", rules: paramRules() }];
  for (const { id, rules } of rulesets) writeFileSync(join(outDir, "rules", `${id}.json`), JSON.stringify(rules));

  const meta = {
    built: new Date().toISOString(),
    lists: Object.fromEntries(
      Object.entries(lists).map(([id, path]) => {
        const text = readFileSync(path, "utf8");
        return [id, { sha256: createHash("sha256").update(text).digest("hex"), version: /^! Version: (.+)$/m.exec(text)?.[1] ?? null }];
      }),
    ),
    stats: compiled.stats,
  };
  writeFileSync(join(outDir, "rules", "meta.json"), JSON.stringify(meta, null, 2));
  checkManifest(outDir, rulesets.map((r) => r.id));

  return {
    outDir,
    rules: Object.fromEntries(rulesets.map((r) => [r.id, r.rules.length])),
    skipped: Object.fromEntries(Object.entries(compiled.stats).map(([id, s]) => [id, s.skipped])),
  };
}

async function bundle(entries: string[], format: "esm" | "iife", outDir: string, minify: boolean): Promise<void> {
  const result = await Bun.build({
    entrypoints: entries.map((e) => join(ROOT, e)),
    root: join(ROOT, "src"),
    outdir: outDir,
    format,
    target: "browser",
    minify,
    splitting: false,
    naming: "[dir]/[name].[ext]",
  });
  if (!result.success) throw new Error(`bundle failed:\n${result.logs.map(String).join("\n")}`);
}

function copyIcons(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const sources: Record<number, string> = {
    16: "default_100_percent/chromium/product_logo_16.png",
    32: "default_100_percent/chromium/product_logo_32.png",
    48: "chromium/product_logo_48.png",
    128: "chromium/product_logo_128.png",
  };
  for (const [size, rel] of Object.entries(sources)) cpSync(join(ICONS, rel), join(dir, `${size}.png`));
}

async function defaultLists(): Promise<Record<string, string>> {
  const paths = Object.fromEntries(Object.keys(LISTS).map((id) => [id, join(CACHE_DIR, `${id}.txt`)]));
  const refresh = process.argv.includes("--refresh");
  if (refresh || Object.values(paths).some((p) => !existsSync(p))) return downloadLists();
  return paths;
}

/** The manifest must name exactly the rulesets the build wrote. */
function checkManifest(outDir: string, ids: string[]): void {
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  const declared: string[] = manifest.declarative_net_request.rule_resources.map((r: { id: string }) => r.id);
  const missing = ids.filter((id) => !declared.includes(id));
  const extra = declared.filter((id) => !ids.includes(id));
  if (missing.length || extra.length) throw new Error(`manifest rulesets differ from the build: missing ${missing}, extra ${extra}`);
}

if (import.meta.main) {
  const report = await build();
  process.stdout.write(`built ${report.outDir}\n`);
  for (const [id, n] of Object.entries(report.rules)) process.stdout.write(`  ${id}: ${n} rules\n`);
  for (const [id, s] of Object.entries(report.skipped)) process.stdout.write(`  ${id} skipped: ${JSON.stringify(s)}\n`);
}
