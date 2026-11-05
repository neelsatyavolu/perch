import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launch, waitFor, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

describe("content blocker", () => {
  test("compiled rulesets are enabled and Chrome accepted every rule", async () => {
    expect(await h.sw<string[]>("chrome.declarativeNetRequest.getEnabledRulesets()")).toEqual(["easylist", "easyprivacy", "params"]);
  });

  test("blocks listed hosts and patterns, honours exceptions and third-party options", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/blocker.html"));
    expect(await tab.evaluate("done")).toEqual({
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
    await h.sw(`chrome.storage.local.set({ settings: {} })`);
    await waitFor(async () => ((await h.sw<string[]>("chrome.declarativeNetRequest.getEnabledRulesets()")).length === 3 ? true : null), "rulesets on");
  });
});
