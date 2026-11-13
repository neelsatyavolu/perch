import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launch, waitFor, type Harness } from "./harness";

const ALL_RULESETS = ["easylist", "easyprivacy", "ubo-privacy", "params"];

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

describe("content blocker", () => {
  test("compiled rulesets are enabled and Chrome accepted every rule", async () => {
    expect(await h.sw<string[]>("chrome.declarativeNetRequest.getEnabledRulesets()")).toEqual(ALL_RULESETS);
  });

  test("uBlock's privacy list and Peter Lowe's list block their hosts", async () => {
    const outcome = (url: string) =>
      h.sw<string[]>(
        `chrome.declarativeNetRequest.testMatchOutcome({ url: ${JSON.stringify(url)}, type: "script", initiator: "http://site.localhost/", tabId: -1 }).then((r) => r.matchedRules.map((m) => m.rulesetId))`,
      );
    expect(await outcome("http://ubo-tracker.localhost/t.js")).toEqual(["ubo-privacy"]);
  });

  test("blocks listed hosts and patterns, honours exceptions and third-party options", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/blocker.html"));
    expect(await tab.evaluate<Record<string, string>>("done")).toEqual({
      ad: "blocked",
      allowed: "loaded",
      bannerAd: "blocked",
      tracker: "blocked",
      app: "loaded",
    });
    expect(h.site.hits.some((hit) => hit.host === "ads.localhost" && hit.path === "/ad.js")).toBe(false);
    expect(h.site.hits.some((hit) => hit.host === "tracker.localhost")).toBe(false);
    await tab.close();
  });

  test("the panel counts what was blocked on the page", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/blocker.html"));
    await tab.evaluate("done");
    const tabId = await h.tabIdOf(tab);
    const panel = await h.extensionPage(`popup.html?tabId=${tabId}`);
    const blocked = await waitFor(() => panel.evaluate<string | null>(`document.querySelector("[data-stat=blocked]")?.textContent ?? null`), "panel counts");
    expect(blocked).toBe("3");
    await panel.close();
    await tab.close();
  });
});

describe("tracking parameters", () => {
  test("are removed from page loads, other parameters and the fragment stay", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/plain.html?id=5&utm_source=news&fbclid=abc&gclid=x&mc_eid=9&q=a+b#top"));
    expect(await tab.url()).toBe(h.site.url("site.localhost", "/plain.html?id=5&q=a+b#top"));
    const served = h.site.hits.filter((hit) => hit.path === "/plain.html");
    expect(served.every((hit) => !hit.query.includes("utm_source"))).toBe(true);
    await tab.close();
  });

  test("clean URLs load without a redirect", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/plain.html?page=2"));
    expect(await tab.url()).toBe(h.site.url("site.localhost", "/plain.html?page=2"));
    await tab.close();
  });
});

describe("protections off for a site", () => {
  test("lets that site's requests and parameters through, and turning it back on restores blocking", async () => {
    await h.sw(`chrome.storage.local.set({ settings: { sitesOff: ["site.localhost"] } })`);
    await waitFor(async () => ((await h.sw<unknown[]>("chrome.declarativeNetRequest.getDynamicRules()")).length === 1 ? true : null), "site rule");

    const off = await h.open(h.site.url("site.localhost", "/blocker.html?utm_source=x"));
    expect(await off.evaluate("done")).toMatchObject({ ad: "loaded", tracker: "loaded", bannerAd: "loaded" });
    expect(await off.url()).toContain("utm_source=x");
    await off.close();

    await h.sw(`chrome.storage.local.set({ settings: { sitesOff: [] } })`);
    await waitFor(async () => ((await h.sw<unknown[]>("chrome.declarativeNetRequest.getDynamicRules()")).length === 0 ? true : null), "site rule removed");
    const on = await h.open(h.site.url("site.localhost", "/blocker.html"));
    expect(await on.evaluate("done")).toMatchObject({ ad: "blocked", tracker: "blocked" });
    await on.close();
  });

  test("the blocker switch in settings disables the filter rulesets", async () => {
    await h.sw(`chrome.storage.local.set({ settings: { blocker: false } })`);
    await waitFor(async () => {
      const ids = await h.sw<string[]>("chrome.declarativeNetRequest.getEnabledRulesets()");
      return ids.length === 1 && ids[0] === "params" ? true : null;
    }, "rulesets off");
    expect(await h.sw<string[]>(`chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id))`)).not.toContain("perch-cosmetic");
    await h.sw(`chrome.storage.local.set({ settings: {} })`);
    await waitFor(async () => ((await h.sw<string[]>("chrome.declarativeNetRequest.getEnabledRulesets()")).length === ALL_RULESETS.length ? true : null), "rulesets on");
    await waitFor(async () => ((await h.sw<string[]>(`chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id))`)).includes("perch-cosmetic") ? true : null), "element hiding on");
  });
});

describe("element hiding", () => {
  const shown = async (host: string) => {
    const tab = await h.open(h.site.url(host, "/cosmetic.html"));
    return { tab, shown: () => tab.evaluate<Record<string, string>>("shown()") };
  };

  test("hides generic and site-specific selectors, honours #@# exceptions and leaves the rest", async () => {
    const page = await shown("site.localhost");
    await waitFor(async () => ((await page.shown())["site-ad"] === "none" ? true : null), "site-specific hide");
    expect(await page.shown()).toEqual({ "generic-ad": "none", "excepted-ad": "flex", "site-ad": "none", "other-ad": "block", plain: "block" });
    await page.tab.close();

    const other = await shown("other.localhost");
    await waitFor(async () => ((await other.shown())["other-ad"] === "none" ? true : null), "other site's hide");
    expect(await other.shown()).toEqual({ "generic-ad": "none", "excepted-ad": "none", "site-ad": "block", "other-ad": "none", plain: "block" });
    await other.tab.close();
  });

  test("a site with protections off and the blocker switch both turn it off", async () => {
    const nothingHidden = { "generic-ad": "block", "excepted-ad": "flex", "site-ad": "block", "other-ad": "block", plain: "block" };
    const scripts = () => h.sw<{ id: string; excludeMatches?: string[] }[]>("chrome.scripting.getRegisteredContentScripts()");

    await h.sw(`chrome.storage.local.set({ settings: { sitesOff: ["site.localhost"] } })`);
    await waitFor(async () => ((await scripts()).find((s) => s.id === "perch-cosmetic")?.excludeMatches?.includes("*://site.localhost/*") ? true : null), "exempt");
    const off = await shown("site.localhost");
    await Bun.sleep(500);
    expect(await off.shown()).toEqual(nothingHidden);
    await off.tab.close();

    await h.sw(`chrome.storage.local.set({ settings: { blocker: false } })`);
    await waitFor(async () => ((await scripts()).some((s) => s.id === "perch-cosmetic") ? null : true), "unregistered");
    const disabled = await shown("other.localhost");
    await Bun.sleep(500);
    expect(await disabled.shown()).toEqual(nothingHidden);
    await disabled.tab.close();

    await h.sw(`chrome.storage.local.set({ settings: {} })`);
    await waitFor(async () => ((await scripts()).some((s) => s.id === "perch-cosmetic") ? true : null), "registered again");
  });
});
