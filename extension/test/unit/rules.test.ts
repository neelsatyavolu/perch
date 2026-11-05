import { describe, expect, test } from "bun:test";
import { parseFilter } from "../../src/rules/parse";
import { ALLOW_ID_BASE, compileLists, isBlockRuleId, toRule, validateRule } from "../../src/rules/compile";
import { PRIORITY } from "../../src/rules/limits";

function rule(line: string) {
  const parsed = parseFilter(line);
  if (!parsed || "skip" in parsed) throw new Error(`skipped: ${line} (${parsed && "skip" in parsed ? parsed.skip : "blank"})`);
  return toRule(parsed.filter);
}

function skip(line: string): string | undefined {
  const parsed = parseFilter(line);
  return parsed && "skip" in parsed ? parsed.skip : undefined;
}

describe("parseFilter", () => {
  test("blank lines, comments and headers are ignored", () => {
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("! Title: EasyList")).toBeNull();
    expect(parseFilter("[Adblock Plus 2.0]")).toBeNull();
  });

  test("cosmetic, scriptlet and regex filters are skipped with a reason", () => {
    expect(skip("example.com##.ad-banner")).toBe("cosmetic");
    expect(skip("##.sponsored")).toBe("cosmetic");
    expect(skip("example.com#@#.ad")).toBe("cosmetic");
    expect(skip("example.com#?#div:-abp-has(.ad)")).toBe("cosmetic");
    expect(skip("example.com#$#abort-on-property-read x")).toBe("cosmetic");
    expect(skip("/banner[0-9]+\\.gif/")).toBe("regex");
  });

  test("unsupported options skip the whole filter rather than widen it", () => {
    expect(skip("||ads.example.com^$popup")).toBe("option:popup");
    expect(skip("||example.com^$csp=script-src 'none'")).toBe("option:csp");
    expect(skip("||example.com^$removeparam=utm_source")).toBe("option:removeparam");
    expect(skip("@@||example.com^$elemhide")).toBe("option:elemhide");
    expect(skip("||example.com^$madeup")).toBe("option:madeup");
  });

  test("entity domains are dropped and a filter left with none is skipped", () => {
    expect(skip("||ads.net^$domain=google.*")).toBe("entity-domain");
    const r = rule("||ads.net^$domain=google.*|example.com");
    expect(r.condition.initiatorDomains).toEqual(["example.com"]);
  });

  test("non-ASCII patterns are skipped, non-ASCII domains become punycode", () => {
    expect(skip("||реклама.example^")).toBe("non-ascii");
    expect(rule("||ads.net^$domain=bücher.de").condition.initiatorDomains).toEqual(["xn--bcher-kva.de"]);
  });
});

describe("toRule", () => {
  test("a plain host filter blocks every subresource", () => {
    expect(rule("||ads.example.com^")).toEqual({
      priority: PRIORITY.block,
      action: { type: "block" },
      condition: { urlFilter: "||ads.example.com^" },
    });
  });

  test("resource types, negated types and party map to DNR conditions", () => {
    expect(rule("||cdn.example.com/ad.js$script,image,third-party").condition).toEqual({
      urlFilter: "||cdn.example.com/ad.js",
      resourceTypes: ["script", "image"],
      domainType: "thirdParty",
    });
    expect(rule("/adserver/*$~script,~stylesheet,1p").condition).toEqual({
      urlFilter: "/adserver/*",
      excludedResourceTypes: ["script", "stylesheet", "main_frame"],
      domainType: "firstParty",
    });
    expect(rule("||x.com^$xhr,subdocument,frame,css,other,websocket,ping,media,font,object").condition.resourceTypes).toEqual([
      "xmlhttprequest",
      "sub_frame",
      "stylesheet",
      "other",
      "websocket",
      "ping",
      "media",
      "font",
      "object",
    ]);
  });

  test("domain= becomes initiator domains, with exclusions", () => {
    expect(rule("||ads.net^$domain=a.com|~b.a.com|C.org").condition).toEqual({
      urlFilter: "||ads.net^",
      initiatorDomains: ["a.com", "c.org"],
      excludedInitiatorDomains: ["b.a.com"],
    });
  });

  test("exceptions outrank blocks; important outranks exceptions", () => {
    expect(rule("@@||example.com/ads.js").priority).toBe(PRIORITY.allow);
    expect(rule("@@||example.com/ads.js").action.type).toBe("allow");
    expect(rule("||tracker.net^$important").priority).toBe(PRIORITY.important);
    expect(PRIORITY.important).toBeGreaterThan(PRIORITY.allow);
    expect(PRIORITY.allow).toBeGreaterThan(PRIORITY.block);
  });

  test("$document exceptions allow the whole page", () => {
    expect(rule("@@||bank.example^$document")).toEqual({
      priority: PRIORITY.allow,
      action: { type: "allowAllRequests" },
      condition: { urlFilter: "||bank.example^", resourceTypes: ["main_frame", "sub_frame"] },
    });
  });

  test("match-case keeps case sensitivity; otherwise DNR's default applies", () => {
    expect(rule("/Ads/Banner.$match-case").condition.isUrlFilterCaseSensitive).toBe(true);
    expect(rule("/Ads/Banner.").condition.isUrlFilterCaseSensitive).toBeUndefined();
  });

  test("anchors are kept and '||*' is rewritten because DNR rejects it", () => {
    expect(rule("|https://ads.").condition.urlFilter).toBe("|https://ads.");
    expect(rule("||*.ads.net/x").condition.urlFilter).toBe("*.ads.net/x");
    expect(rule("*$script,domain=example.com").condition.urlFilter).toBeUndefined();
  });

  test("a filter that would block everything is refused", () => {
    expect(skip("*")).toBe("too-broad");
    expect(skip("$third-party")).toBe("too-broad");
  });
});

describe("validateRule", () => {
  test("accepts compiled rules and rejects malformed ones", () => {
    expect(validateRule({ id: 1, ...rule("||ads.example.com^") })).toBeNull();
    expect(validateRule({ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "||*x" } })).toContain("||*");
    expect(validateRule({ id: 1, priority: 1, action: { type: "block" }, condition: { resourceTypes: [] } })).toContain("empty");
    expect(validateRule({ id: 0, priority: 1, action: { type: "block" }, condition: { urlFilter: "x" } })).toContain("id");
  });
});

describe("compileLists", () => {
  const easylist = [
    "[Adblock Plus 2.0]",
    "! comment",
    "||ads.one.com^",
    "||ads.two.com^",
    "||Ads.Three.com^",
    "||ads.one.com^",
    "||tp.example^$third-party",
    "||tp2.example^$third-party",
    "/banner/*$image",
    "@@||ads.two.com/ok.js",
    "example.com##.ad",
  ].join("\n");
  const easyprivacy = ["||pixel.track^", "||beacon.track^$ping"].join("\n");

  test("plain host filters with the same options merge into one requestDomains rule", () => {
    const out = compileLists([
      { id: "easylist", text: easylist },
      { id: "easyprivacy", text: easyprivacy },
    ]);
    const el = out.rulesets.find((r) => r.id === "easylist")!;
    const merged = el.rules.find((r) => r.condition.requestDomains?.includes("ads.one.com"))!;
    expect(merged.condition.requestDomains).toEqual(["ads.one.com", "ads.three.com", "ads.two.com"]);
    expect(merged.condition.urlFilter).toBeUndefined();
    const thirdParty = el.rules.find((r) => r.condition.requestDomains?.includes("tp.example"))!;
    expect(thirdParty.condition).toEqual({ requestDomains: ["tp.example", "tp2.example"], domainType: "thirdParty" });
    const blockIds = el.rules.filter((r) => r.action.type === "block").map((r) => r.id);
    expect(blockIds).toEqual(blockIds.map((_, i) => i + 1));
    const allow = el.rules.find((r) => r.action.type === "allow")!;
    expect(allow.id).toBe(ALLOW_ID_BASE + 1);
    expect(isBlockRuleId(allow.id)).toBe(false);
    expect(out.stats.easylist!.skipped.cosmetic).toBe(1);
    expect(out.stats.easylist!.filters).toBe(9);
    expect(out.rulesets.find((r) => r.id === "easyprivacy")!.rules).toHaveLength(2);
  });

  test("a single host stays a plain urlFilter rule", () => {
    const out = compileLists([{ id: "a", text: "||only.one^" }]);
    expect(out.rulesets[0]!.rules).toEqual([{ id: 1, priority: PRIORITY.block, action: { type: "block" }, condition: { urlFilter: "||only.one^" } }]);
  });

  test("the rule budget is respected across rulesets and reported", () => {
    const text = Array.from({ length: 50 }, (_, i) => `/path${i}/ad.js`).join("\n");
    const out = compileLists(
      [
        { id: "a", text },
        { id: "b", text: "/other/ad.js\n/more/ad.js" },
      ],
      40,
    );
    const total = out.rulesets.reduce((n, r) => n + r.rules.length, 0);
    expect(total).toBe(40);
    expect(out.stats.a!.skipped.budget).toBe(10);
    expect(out.stats.b!.skipped.budget).toBe(2);
    for (const rs of out.rulesets) for (const r of rs.rules) expect(validateRule(r)).toBeNull();
  });
});
