import { describe, expect, test } from "bun:test";
import { CMP_NAMES, CMP_RULES, isSafeToClick } from "../../src/banners/rules";

describe("cookie banner rules", () => {
  test("cover the consent platforms the spec names", () => {
    for (const name of ["OneTrust", "Didomi", "Quantcast", "TrustArc", "Cookiebot", "Usercentrics", "Sourcepoint"]) {
      expect(CMP_NAMES).toContain(name);
    }
  });

  test("no click target names an accept control", () => {
    const accepty = /accept|agree(?!ing)|allow|consent(?!-required)|optin(?!declineall)|choice_type_11/i;
    for (const rule of CMP_RULES) {
      for (const route of rule.routes) {
        expect(route.length).toBeGreaterThan(0);
        for (const step of route) {
          for (const target of step.click ?? []) {
            const named = target.selector.replace(/disagree|do-not-consent|without-agreeing|LevelOptinDeclineAll/gi, "");
            expect(named).not.toMatch(accepty);
            if (target.text) expect(() => new RegExp(target.text!, "i")).not.toThrow();
          }
        }
      }
    }
  });
});

describe("isSafeToClick", () => {
  test("refuses accepting text and allows refusing text", () => {
    expect(isSafeToClick("Accept all")).toBe(false);
    expect(isSafeToClick("I agree")).toBe(false);
    expect(isSafeToClick("Allow all cookies")).toBe(false);
    expect(isSafeToClick("OK")).toBe(false);
    expect(isSafeToClick("Alle akzeptieren")).toBe(false);
    expect(isSafeToClick("Reject all")).toBe(true);
    expect(isSafeToClick("Disagree and close")).toBe(true);
    expect(isSafeToClick("Continue without agreeing")).toBe(true);
    expect(isSafeToClick("Do not consent")).toBe(true);
    expect(isSafeToClick("Necessary cookies only")).toBe(true);
    expect(isSafeToClick("Confirm my choices")).toBe(true);
    expect(isSafeToClick("")).toBe(true);
  });
});
