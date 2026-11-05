import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../scripts/build";

const LISTS = join(import.meta.dir, "..", "fixtures", "lists");
const lists = { easylist: join(LISTS, "easylist.txt"), easyprivacy: join(LISTS, "easyprivacy.txt") };
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function optionsScript(profileKey?: boolean): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "perch-ext-build-"));
  dirs.push(outDir);
  await build({ outDir, lists, ...(profileKey === undefined ? {} : { profileKey }) });
  return readFileSync(join(outDir, "ui", "options.js"), "utf8");
}

describe("build", () => {
  test("a release build leaves the authenticator's profile key store out entirely", async () => {
    const release = await optionsScript();
    expect(release).not.toContain("perch-vault");
    expect(release).toContain("Keychain");
  });

  test("a development build with --profile-key includes it", async () => {
    expect(await optionsScript(true)).toContain("perch-vault");
  });
});
