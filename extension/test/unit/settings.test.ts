import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, isSiteOff, listableHost, normalizeHost, protectionState, sanitizeSettings, withSiteProtection } from "../../src/shared/settings";
import { siteOffRules, contentScriptPlan, enabledRulesets } from "../../src/background/plan";
import { PRIORITY } from "../../src/rules/limits";
import { validateRule } from "../../src/rules/compile";

describe("settings", () => {
  test("bad or missing values fall back to defaults field by field", () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ blocker: "no", pip: false, sitesOff: ["Example.COM", 4, "", "bad host!", "a.example"] })).toEqual({
      ...DEFAULT_SETTINGS,
      pip: false,
      sitesOff: ["a.example", "example.com"],
    });
  });

  test("hosts are normalised from URLs and bare names", () => {
    expect(normalizeHost("https://News.Example.com:8443/path")).toBe("news.example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("site.localhost")).toBe("site.localhost");
    expect(normalizeHost("nodots")).toBeNull();
    expect(normalizeHost("")).toBeNull();
  });

  test("turning a site off and on again is immutable and idempotent", () => {
    const off = withSiteProtection(DEFAULT_SETTINGS, "example.com", false);
    expect(DEFAULT_SETTINGS.sitesOff).toEqual([]);
    expect(withSiteProtection(off, "example.com", false).sitesOff).toEqual(["example.com"]);
    expect(isSiteOff(off, "www.example.com")).toBe(true);
    expect(isSiteOff(off, "badexample.com")).toBe(false);
    expect(withSiteProtection(off, "example.com", true).sitesOff).toEqual([]);
  });

  test("turning protections on for a subdomain removes the parent entry that turned them off", () => {
    const off = { ...DEFAULT_SETTINGS, sitesOff: ["example.com", "other.example"] };
    const on = withSiteProtection(off, "sub.example.com", true);
    expect(isSiteOff(on, "sub.example.com")).toBe(false);
    expect(on.sitesOff).toEqual(["other.example"]);
  });

  test("single-label intranet hosts can be listed; IPv6 literals cannot", () => {
    expect(listableHost("intranet")).toBe("intranet");
    expect(listableHost("Router.")).toBe("router");
    expect(listableHost("news.example.com")).toBe("news.example.com");
    expect(listableHost("[::1]")).toBeNull();
    expect(listableHost("bad host!")).toBeNull();
    expect(sanitizeSettings({ sitesOff: ["intranet", "[::1]"] }).sitesOff).toEqual(["intranet"]);
    expect(withSiteProtection(DEFAULT_SETTINGS, "intranet", false).sitesOff).toEqual(["intranet"]);
  });

  test("protectionState says whether the switch can act and which entry turned protections off", () => {
    const settings = { ...DEFAULT_SETTINGS, sitesOff: ["example.com"] };
    expect(protectionState(settings, "example.com")).toEqual({ on: false, listable: true, offBy: "example.com" });
    expect(protectionState(settings, "sub.example.com")).toEqual({ on: false, listable: true, offBy: "example.com" });
    expect(protectionState(settings, "other.example")).toEqual({ on: true, listable: true, offBy: null });
    expect(protectionState(settings, "[::1]")).toEqual({ on: true, listable: false, offBy: null });
  });
});

describe("siteOffRules", () => {
  test("no sites, no rules; otherwise one top-priority allowAllRequests rule", () => {
    expect(siteOffRules([])).toEqual([]);
    const [rule] = siteOffRules(["a.example", "b.example"]);
    expect(validateRule(rule!)).toBeNull();
    expect(rule).toEqual({
      id: 1,
      priority: PRIORITY.siteOff,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: ["a.example", "b.example"], resourceTypes: ["main_frame", "sub_frame"] },
    });
  });
});

describe("contentScriptPlan", () => {
  test("registers a script per enabled feature and skips sites with protections off for banners only", () => {
    const plan = contentScriptPlan({ ...DEFAULT_SETTINGS, linkPreview: false, sitesOff: ["a.example"] });
    expect(plan.map((s) => s.id)).toEqual(["perch-cosmetic", "perch-banners", "perch-pip", "perch-speed"]);
    const banners = plan.find((s) => s.id === "perch-banners")!;
    expect(banners.excludeMatches).toEqual(["*://a.example/*", "*://*.a.example/*"]);
    expect(banners.allFrames).toBe(true);
    expect(plan.find((s) => s.id === "perch-pip")!.excludeMatches).toBeUndefined();
  });

  test("generic element hiding runs at document start in every frame, skipping exempt and $generichide sites", () => {
    const plan = contentScriptPlan({ ...DEFAULT_SETTINGS, sitesOff: ["a.example"] }, ["g.example"]);
    expect(plan.find((s) => s.id === "perch-cosmetic")).toEqual({
      id: "perch-cosmetic",
      css: ["cosmetic/generic.css"],
      matches: ["http://*/*", "https://*/*"],
      excludeMatches: ["*://a.example/*", "*://*.a.example/*", "*://g.example/*", "*://*.g.example/*"],
      allFrames: true,
      runAt: "document_start",
    });
  });

  test("the blocker switch removes generic element hiding", () => {
    expect(contentScriptPlan({ ...DEFAULT_SETTINGS, blocker: false }, ["g.example"]).map((s) => s.id)).not.toContain("perch-cosmetic");
  });
});

describe("enabledRulesets", () => {
  test("the blocker switch covers every filter list; params has its own", () => {
    expect(enabledRulesets(DEFAULT_SETTINGS)).toEqual({ enable: ["easylist", "easyprivacy", "ubo-privacy", "params"], disable: [] });
    expect(enabledRulesets({ ...DEFAULT_SETTINGS, blocker: false })).toEqual({
      enable: ["params"],
      disable: ["easylist", "easyprivacy", "ubo-privacy"],
    });
  });
});
