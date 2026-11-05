/**
 * Import from the terminal, until the wizard screen lands (same API underneath):
 *
 *   bun run src/import/cli.ts list
 *   bun run src/import/cli.ts count <browser> [profile]
 *   bun run src/import/cli.ts import <browser> [profile] [--types bookmarks,history,…] [--perch <dir>]
 *   bun run src/import/cli.ts file <path.zip|.csv|.html> [--perch <dir>]
 *
 * Output never includes passwords, cookie values or other secrets; only counts and messages.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TypeResult } from "./apply";
import { macKeychain, type Keychain } from "./keychain";
import { DEFAULT_TYPES } from "./types";
import { countSource, importFile, importSource, listSources, type Report } from "./wizard";

const USAGE = "usage: import list | count <browser> [profile] | import <browser> [profile] [--types a,b] [--perch <dir>] | file <path> [--perch <dir>]";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

function describe(r: TypeResult): string {
  const skipped = r.skipped ? `, ${r.skipped} skipped` : "";
  switch (r.status) {
    case "written":
      return `${r.type}: ${r.count} added${skipped}`;
    case "bundled":
      return `${r.type}: ${r.count} ready, applied when Perch next starts${skipped}`;
    case "empty":
      return `${r.type}: nothing to import${skipped}`;
    default:
      return `${r.type}: ${r.message ?? "not imported"}`;
  }
}

function print(report: Report): number {
  for (const r of report.results) process.stdout.write(`${describe(r)}\n`);
  return report.results.some((r) => r.status === "failed") ? 1 : 0;
}

export async function main(argv: string[], deps: { home: string; keychain: Keychain } = { home: homedir(), keychain: macKeychain() }): Promise<number> {
  const args = [...argv];
  const { home, keychain } = deps;
  const perch = resolve(option(args, "--perch") ?? join(home, "Library", "Application Support", "Perch"));
  const types = option(args, "--types")?.split(",").map((t) => t.trim());
  const [command, a, b] = args;
  if (command === "list") {
    for (const s of listSources(home, perch)) {
      const access = s.access === "full-disk-access" ? " (needs Full Disk Access)" : "";
      process.stdout.write(`${s.browser}\t${s.name}${access}\n`);
      for (const p of s.profiles) process.stdout.write(`  ${p.id || "(default)"}\t${p.name}${p.lastImported ? `\timported ${new Date(p.lastImported).toLocaleDateString()}` : ""}\n`);
    }
    return 0;
  }
  if (command === "count" && a) {
    const counts = await countSource(home, { browser: a, profile: b ?? (listSources(home).find((s) => s.browser === a)?.profiles[0]?.id ?? "") });
    for (const [type, v] of Object.entries(counts)) process.stdout.write(`${type}: ${"count" in v! ? v.count : v!.unavailable}\n`);
    return 0;
  }
  if (command === "import" && a) {
    const profile = b ?? listSources(home).find((s) => s.browser === a)?.profiles[0]?.id ?? "";
    return print(await importSource({ home, source: { browser: a, profile }, types: types ?? DEFAULT_TYPES, target: { userDataDir: perch }, keychain }));
  }
  if (command === "file" && a) return print(await importFile({ path: resolve(a), target: { userDataDir: perch }, keychain }));
  process.stderr.write(`${USAGE}\n`);
  return 64;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
