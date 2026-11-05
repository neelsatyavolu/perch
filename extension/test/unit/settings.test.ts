import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, isSiteOff, normalizeHost, sanitizeSettings, withSiteProtection } from "../../src/shared/settings";
import { siteOffRules, contentScriptPlan } from "../../src/background/plan";
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
    expect(plan.map((s) => s.id)).toEqual(["perch-banners", "perch-pip", "perch-speed"]);
    const banners = plan.find((s) => s.id === "perch-banners")!;
    expect(banners.excludeMatches).toEqual(["*://a.example/*", "*://*.a.example/*"]);
    expect(banners.allFrames).toBe(true);
    expect(plan.find((s) => s.id === "perch-pip")!.excludeMatches).toBeUndefined();
  });
});
