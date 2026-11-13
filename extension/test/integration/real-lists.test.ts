/**
 * Compiles the real EasyList and EasyPrivacy (downloaded by `bun run lists` into .cache/lists) and
 * checks that Chrome accepts every rule and blocks well-known hosts. Skipped when the lists are not
 * downloaded, so the suite never needs the network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type BuildReport } from "../../scripts/build";
import { CACHE_DIR } from "../../scripts/lists";
import { FILTER_RULESET_IDS, isFilterRuleset } from "../../src/rules/rulesets";
import { sanitizeCosmetic } from "../../src/cosmetic/data";
import { hideCss } from "../../src/cosmetic/selector";
import { launch, type Harness } from "./harness";

const lists = Object.fromEntries(FILTER_RULESET_IDS.map((id) => [id, join(CACHE_DIR, `${id}.txt`)]));
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
    expect(await h.sw<string[]>("chrome.declarativeNetRequest.getEnabledRulesets()")).toEqual(["easylist", "easyprivacy", "ubo-privacy", "params"]);
  });

  const outcome = (url: string, type: string, initiator = "https://news.example/") =>
    h.sw<string[]>(
      `chrome.declarativeNetRequest.testMatchOutcome({ url: ${JSON.stringify(url)}, type: ${JSON.stringify(type)}, initiator: ${JSON.stringify(initiator)}, tabId: -1 }).then((r) => r.matchedRules.map((m) => m.rulesetId))`,
    );

  test("block well-known ad and tracker requests from other sites", async () => {
    // Peter Lowe's list also names these hosts, so any filter list may be the one Chrome reports.
    expect((await outcome("https://securepubads.g.doubleclick.net/tag/js/gpt.js", "script")).some(isFilterRuleset)).toBe(true);
    expect((await outcome("https://www.google-analytics.com/analytics.js", "script")).some(isFilterRuleset)).toBe(true);
  });

  test("leave ordinary first-party requests alone", async () => {
    expect(await outcome("https://news.example/app.js", "script")).toEqual([]);
  });

  test("every element-hiding rule parses in Chrome: no group lost to a bad selector", async () => {
    const generic = readFileSync(join(outDir, "cosmetic", "generic.css"), "utf8");
    const data = sanitizeCosmetic(JSON.parse(readFileSync(join(outDir, "cosmetic", "sites.json"), "utf8")));
    expect(report.cosmetic.generic).toBeGreaterThan(1_000);
    expect(data.selectors.length).toBeGreaterThan(1_000);
    const tab = await h.open(h.site.url("site.localhost", "/plain.html"));
    // Every group must survive; for site selectors, name any one Chrome rejects.
    const dropped = (rules: string[]) =>
      tab.evaluate<string[]>(
        `${JSON.stringify(rules)}.filter((rule) => { const sheet = new CSSStyleSheet(); sheet.replaceSync(rule); return sheet.cssRules.length !== 1; })`,
      );
    expect((await dropped(generic.split("\n"))).map((rule) => rule.slice(0, 200))).toEqual([]);
    expect(await dropped(data.selectors.map((s) => hideCss([s])))).toEqual([]);
    await tab.close();
  });
});
