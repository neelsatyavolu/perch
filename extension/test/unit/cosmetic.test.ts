import { describe, expect, test } from "bun:test";
import { compileCosmetic } from "../../src/cosmetic/compile";
import { coveredBy, genericExemptHosts, hostChain, sanitizeCosmetic, siteCss, siteSelectors } from "../../src/cosmetic/data";
import { parseCosmetic } from "../../src/cosmetic/parse";
import { checkSelector, hideCss } from "../../src/cosmetic/selector";

const compile = (...lines: string[]) => compileCosmetic([{ id: "test", text: lines.join("\n") }]);
const skip = (line: string) => {
  const parsed = parseCosmetic(line);
  return parsed && "skip" in parsed ? parsed.skip : undefined;
};

describe("checkSelector", () => {
  test("accepts plain CSS, attribute values with colons and escaped characters", () => {
    for (const ok of [
      ".ad",
      "#ad-top-banner",
      'a[href^="https://ads.example/"]',
      "div[class*='sponsor']:not(.keep) > .slot",
      "aside:has(> .ad-label)",
      ".lg\\:min-h-\\[250px\\]",
      "li:nth-child(2n+1)",
      "div::before",
      'div[data-x="{curly};"]',
      "div:has(> .a):has(.b)",
      "div:is(.a, .b):has(:not(.c))",
    ]) {
      expect(checkSelector(ok)).toBeNull();
    }
  });

  test("rejects procedural extensions and scriptlets", () => {
    expect(checkSelector("div:-abp-has(.ad)")).toBe("procedural");
    expect(checkSelector("div:has-text(Sponsored)")).toBe("procedural");
    expect(checkSelector(".ad:upward(2)")).toBe("procedural");
    expect(checkSelector(".ad:remove()")).toBe("procedural");
    expect(checkSelector(".ad:style(height: 0)")).toBe("procedural");
    expect(checkSelector(":xpath(//div)")).toBe("procedural");
    expect(checkSelector("+js(set-constant, x, 1)")).toBe("procedural");
    expect(checkSelector("^script:has-text(ads)")).toBe("procedural");
    expect(checkSelector(".header {top:0;}")).toBe("procedural");
  });

  test("rejects anything that would break or escape the rule", () => {
    for (const bad of ["", "div[class", "div]", ".a)", ":not(.a", '[x="open]', ".a}body{display:none", ".a;", "div >", ", .a", ".a,,.b", ".a:madeup", "div\\", "article:has(header:has(.x))"]) {
      expect(checkSelector(bad)).toBe("invalid-selector");
    }
  });

  test("hideCss groups selectors so one rule holds at most the group size", () => {
    expect(hideCss([])).toBe("");
    expect(hideCss([".a", ".b", ".c"], 2)).toBe(".a,.b{display:none!important}\n.c{display:none!important}");
  });
});

describe("parseCosmetic", () => {
  test("generic, site-specific and exception filters", () => {
    expect(parseCosmetic("##.ad")).toEqual({ filter: { exception: false, include: [], exclude: [], selector: ".ad" } });
    expect(parseCosmetic("Example.com,~Sub.Example.com##.ad")).toEqual({
      filter: { exception: false, include: ["example.com"], exclude: ["sub.example.com"], selector: ".ad" },
    });
    expect(parseCosmetic("example.com#@#.ad")).toEqual({ filter: { exception: true, include: ["example.com"], exclude: [], selector: ".ad" } });
    expect(parseCosmetic("bücher.de##.ad")).toMatchObject({ filter: { include: ["xn--bcher-kva.de"] } });
  });

  test("network filters, comments and blank lines are not element hiding", () => {
    expect(parseCosmetic("||ads.example^")).toBeNull();
    expect(parseCosmetic("! comment ##.x")).toBeNull();
    expect(parseCosmetic("[Adblock Plus 2.0]")).toBeNull();
    expect(parseCosmetic("@@||example.com^$script")).toBeNull();
  });

  test("procedural filters, scriptlets and invalid selectors are skipped with a reason", () => {
    expect(skip("example.com#?#div:-abp-has(.ad)")).toBe("procedural");
    expect(skip("example.com#$#abort-on-property-read x")).toBe("procedural");
    expect(skip("example.com#@?#div:-abp-has(.ad)")).toBe("procedural");
    expect(skip("example.com#%#window.x = 1")).toBe("procedural");
    expect(skip("example.com##+js(set-constant, x, 1)")).toBe("scriptlet");
    expect(skip("example.com#@#+js(set-constant, x, 1)")).toBe("scriptlet");
    expect(skip("example.com##div:has-text(Ad)")).toBe("procedural");
    expect(skip("example.com##div[class")).toBe("invalid-selector");
  });

  test("entity and regex domains are dropped; a filter left with no sites is skipped", () => {
    expect(skip("google.*##.ad")).toBe("unsupported-domain");
    expect(skip("/^example\\./##.ad")).toBe("unsupported-domain");
    expect(parseCosmetic("google.*,example.com##.ad")).toMatchObject({ filter: { include: ["example.com"] } });
  });

  test("$generichide and $elemhide exceptions name the sites they switch off", () => {
    expect(parseCosmetic("@@||Example.com^$generichide")).toEqual({ hideSwitch: { kind: "generichide", hosts: ["example.com"] } });
    expect(parseCosmetic("@@||example.com^$ghide")).toEqual({ hideSwitch: { kind: "generichide", hosts: ["example.com"] } });
    expect(parseCosmetic("@@||example.com^$elemhide")).toEqual({ hideSwitch: { kind: "elemhide", hosts: ["example.com"] } });
    expect(parseCosmetic("@@$generichide,domain=a.com|b.com")).toEqual({ hideSwitch: { kind: "generichide", hosts: ["a.com", "b.com"] } });
    expect(skip("@@||bing.com/search?$generichide")).toBe("generichide-url");
    expect(skip("@@://localhost/$generichide")).toBe("generichide-url");
  });
});

describe("compileCosmetic", () => {
  test("generic selectors go in the static stylesheet, site selectors in the data", () => {
    const { genericCss, data, stats } = compile("##.ad", "##.banner", "example.com##.promo", "a.com,b.com##.shared");
    expect(genericCss).toBe(".ad,.banner{display:none!important}");
    expect(data.generic).toEqual([]);
    expect(Object.keys(data.hide)).toEqual(["a.com", "b.com", "example.com"]);
    expect(data.hide["a.com"]!.map((i) => data.selectors[i])).toEqual([".shared"]);
    expect(data.hide["a.com"]).toEqual(data.hide["b.com"]!);
    expect(stats).toMatchObject({ generic: 2, genericExcepted: 0, siteSelectors: 3, sites: 3 });
  });

  test("a generic selector some site excepts moves out of the static stylesheet", () => {
    const { genericCss, data, stats } = compile("##.ad", "##.ad-slot", "news.example#@#.ad-slot", "~shop.example##.sponsor");
    expect(genericCss).toBe(".ad{display:none!important}");
    expect(data.generic.map((i) => data.selectors[i])).toEqual([".ad-slot", ".sponsor"]);
    expect(stats.genericExcepted).toBe(2);
    expect(siteSelectors(data, "news.example")).toEqual([".sponsor"]);
    expect(siteSelectors(data, "www.news.example")).toEqual([".sponsor"]);
    expect(siteSelectors(data, "shop.example")).toEqual([".ad-slot"]);
    expect(siteSelectors(data, "elsewhere.example")).toEqual([".ad-slot", ".sponsor"]);
  });

  test("site exceptions and exclusions apply to subdomains", () => {
    const { data } = compile("example.com,~m.example.com##.promo", "example.com##.side", "www.example.com#@#.side");
    expect(siteSelectors(data, "example.com")).toEqual([".promo", ".side"]);
    expect(siteSelectors(data, "m.example.com")).toEqual([".side"]);
    expect(siteSelectors(data, "a.m.example.com")).toEqual([".side"]);
    expect(siteSelectors(data, "www.example.com")).toEqual([".promo"]);
    expect(siteSelectors(data, "notexample.com")).toEqual([]);
  });

  test("an exception with no site removes the selector everywhere", () => {
    const { genericCss, data } = compile("##.ad", "##.keep", "example.com##.ad", "#@#.ad");
    expect(genericCss).toBe(".keep{display:none!important}");
    expect(siteSelectors(data, "example.com")).toEqual([]);
  });

  test("$generichide keeps generic hiding off a site but not its own hides; $elemhide turns all of it off", () => {
    const { data, stats } = compile("##.ad", "##.slot", "a.com#@#.slot", "g.com##.own", "e.com##.own", "@@||g.com^$generichide", "@@||e.com^$elemhide");
    expect(siteSelectors(data, "g.com")).toEqual([".own"]);
    expect(siteSelectors(data, "www.g.com")).toEqual([".own"]);
    expect(siteSelectors(data, "e.com")).toEqual([]);
    expect(siteSelectors(data, "other.com")).toEqual([".slot"]);
    expect(genericExemptHosts(data)).toEqual(["e.com", "g.com"]);
    expect(stats).toMatchObject({ genericHideSites: 1, elemHideSites: 1 });
  });

  test("procedural filters, scriptlets and bad selectors never reach the output", () => {
    const { genericCss, data, stats } = compile(
      "##.ok",
      "##div[class",
      "example.com##.x:has-text(Ad)",
      "example.com#?#.y:-abp-has(.z)",
      "example.com##+js(nobab)",
      "example.com##.fine",
    );
    expect(genericCss).toBe(".ok{display:none!important}");
    expect(data.selectors).toEqual([".fine"]);
    expect(stats.skipped).toEqual({ "invalid-selector": 1, procedural: 2, scriptlet: 1 });
  });

  test("lists are merged and duplicates collapse", () => {
    const out = compileCosmetic([
      { id: "a", text: "##.ad\nexample.com##.promo" },
      { id: "b", text: "##.ad\nexample.com##.promo\nexample.com#@#.unused" },
    ]);
    expect(out.genericCss).toBe(".ad{display:none!important}");
    expect(out.data.hide["example.com"]!.length).toBe(1);
    // An exception for something nothing hides is dropped.
    expect(out.data.unhide).toEqual({});
  });
});

describe("host matching", () => {
  test("hostChain walks up to every parent domain", () => {
    expect(hostChain("a.b.Example.co.uk.")).toEqual(["a.b.example.co.uk", "b.example.co.uk", "example.co.uk", "co.uk", "uk"]);
    expect(hostChain("localhost")).toEqual(["localhost"]);
    expect(hostChain("192.168.1.10")).toEqual(["192.168.1.10"]);
    expect(hostChain("[::1]")).toEqual(["[::1]"]);
    expect(hostChain("")).toEqual([]);
  });

  test("coveredBy matches the host and its subdomains, never look-alikes", () => {
    expect(coveredBy(["example.com"], "example.com")).toBe(true);
    expect(coveredBy(["example.com"], "www.example.com")).toBe(true);
    expect(coveredBy(["example.com"], "badexample.com")).toBe(false);
    expect(coveredBy(["www.example.com"], "example.com")).toBe(false);
  });

  test("siteCss is empty with nothing to hide and grouped CSS otherwise", () => {
    const { data } = compile("example.com##.a", "example.com##.b");
    expect(siteCss(data, "other.com")).toBe("");
    expect(siteCss(data, "example.com")).toBe(".a,.b{display:none!important}");
  });

  test("sanitizeCosmetic rejects a malformed file instead of throwing later", () => {
    expect(sanitizeCosmetic(null).selectors).toEqual([]);
    expect(sanitizeCosmetic({ selectors: [1] }).selectors).toEqual([]);
    const { data } = compile("example.com##.a");
    expect(sanitizeCosmetic(JSON.parse(JSON.stringify(data)))).toEqual(data);
  });
});
