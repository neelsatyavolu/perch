import { describe, expect, test } from "bun:test";
import { TRACKING_PARAMS } from "../../src/params/list";
import { paramRules, stripTrackingParams } from "../../src/params/strip";
import { validateRule } from "../../src/rules/compile";
import { PRIORITY } from "../../src/rules/limits";

describe("stripTrackingParams", () => {
  test("removes utm_*, click ids and mailing ids, keeps everything else in order", () => {
    expect(stripTrackingParams("https://shop.example/item?id=5&utm_source=news&utm_medium=email&color=red&fbclid=abc&gclid=x&mc_eid=9")).toBe(
      "https://shop.example/item?id=5&color=red",
    );
  });

  test("removes utm_ parameters that are not in the list", () => {
    expect(stripTrackingParams("https://a.example/?utm_newthing=1&q=2")).toBe("https://a.example/?q=2");
  });

  test("drops the question mark when nothing is left and keeps the fragment", () => {
    expect(stripTrackingParams("https://a.example/page?utm_campaign=x#section")).toBe("https://a.example/page#section");
  });

  test("leaves clean URLs, look-alike names and non-web URLs untouched", () => {
    expect(stripTrackingParams("https://a.example/?q=utm_source")).toBe("https://a.example/?q=utm_source");
    expect(stripTrackingParams("https://a.example/?xfbclid=1")).toBe("https://a.example/?xfbclid=1");
    expect(stripTrackingParams("mailto:a@b.example?utm_source=x")).toBe("mailto:a@b.example?utm_source=x");
    expect(stripTrackingParams("not a url")).toBe("not a url");
  });

  test("keeps the exact original text when nothing is removed", () => {
    expect(stripTrackingParams("https://a.example/?q=a+b&x=%20")).toBe("https://a.example/?q=a+b&x=%20");
  });
});

describe("TRACKING_PARAMS", () => {
  test("covers the parameters the spec names and has no duplicates", () => {
    for (const name of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "mc_eid", "msclkid"]) {
      expect(TRACKING_PARAMS).toContain(name);
    }
    expect(new Set(TRACKING_PARAMS).size).toBe(TRACKING_PARAMS.length);
  });
});

describe("paramRules", () => {
  test("one redirect rule for page and frame loads that removes the listed parameters", () => {
    const rules = paramRules();
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(validateRule(rule!)).toBeNull();
    expect(rule!.priority).toBe(PRIORITY.params);
    expect(rule!.condition.resourceTypes).toEqual(["main_frame", "sub_frame"]);
    expect(rule!.action).toEqual({ type: "redirect", redirect: { transform: { queryTransform: { removeParams: [...TRACKING_PARAMS] } } } });
  });
});
