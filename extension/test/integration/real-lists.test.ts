/**
 * Compiles the real EasyList and EasyPrivacy (downloaded by `bun run lists` into .cache/lists) and
 * checks that Chrome accepts every rule and blocks well-known hosts. Skipped when the lists are not
 * downloaded, so the suite never needs the network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type BuildReport } from "../../scripts/build";
import { CACHE_DIR } from "../../scripts/lists";
import { launch, type Harness } from "./harness";

const lists = { easylist: join(CACHE_DIR, "easylist.txt"), easyprivacy: join(CACHE_DIR, "easyprivacy.txt") };
const haveLists = Object.values(lists).every((p) => existsSync(p));

let h: Harness;
let report: BuildReport;
let outDir: string;

describe.skipIf(!haveLists)("real filter lists", () => {
  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "perch-ext-real-"));
    report = await build({ outDir, lists });
    h = await launch([], outDir);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  test("fit Chrome's guaranteed static rule budget", () => {
    const total = Object.values(report.rules).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(1_000);
    expect(total).toBeLessThan(30_000);
  });

  test("Chrome enables every ruleset", async () => {
    expect(await h.sw<string[]>("chrome.declarativeNetRequest.getEnabledRulesets()")).toEqual(["easylist", "easyprivacy", "params"]);
  });

  const outcome = (url: string, type: string, initiator = "https://news.example/") =>
    h.sw<string[]>(
      `chrome.declarativeNetRequest.testMatchOutcome({ url: ${JSON.stringify(url)}, type: ${JSON.stringify(type)}, initiator: ${JSON.stringify(initiator)}, tabId: -1 }).then((r) => r.matchedRules.map((m) => m.rulesetId))`,
    );

  test("block well-known ad and tracker requests from other sites", async () => {
    expect(await outcome("https://securepubads.g.doubleclick.net/tag/js/gpt.js", "script")).toContain("easylist");
    expect(await outcome("https://www.google-analytics.com/analytics.js", "script")).toContain("easyprivacy");
  });

  test("leave ordinary first-party requests alone", async () => {
    expect(await outcome("https://news.example/app.js", "script")).toEqual([]);
  });
});
