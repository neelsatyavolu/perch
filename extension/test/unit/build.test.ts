import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../scripts/build";
import { FILTER_RULESET_IDS } from "../../src/rules/rulesets";

const LISTS = join(import.meta.dir, "..", "fixtures", "lists");
const lists = Object.fromEntries(FILTER_RULESET_IDS.map((id) => [id, join(LISTS, `${id}.txt`)]));
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let built: Promise<string> | null = null;
function buildOnce(): Promise<string> {
  built ??= (async () => {
    const outDir = mkdtempSync(join(tmpdir(), "perch-ext-build-"));
    dirs.push(outDir);
    await build({ outDir, lists });
    return outDir;
  })();
  return built;
}

const read = async (path: string) => readFileSync(join(await buildOnce(), path), "utf8");

describe("build", () => {
  test("one build for every channel: no profile-key gate is compiled in", async () => {
    const options = await read("ui/options.js");
    expect(options).not.toContain("PERCH_PROFILE_KEY");
    // The authenticator asks Perch for its key; the IndexedDB key stays for unpacked installs and migration.
    expect(options).toContain("co.xanom.perch.keys");
    expect(options).toContain("perch-vault");
  });

  test("the service worker carries the native key path for perchFillCode", async () => {
    const worker = await read("background/index.js");
    expect(worker).toContain("perchFillCode");
    expect(worker).toContain("co.xanom.perch.keys");
  });

  test("the manifest asks for native messaging", async () => {
    expect(JSON.parse(await read("manifest.json")).permissions).toContain("nativeMessaging");
  });
});
