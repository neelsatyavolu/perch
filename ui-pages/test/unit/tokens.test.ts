import { describe, expect, test } from "bun:test";
import { ACCENTS, ACCENT_NAMES, THEMES, THEME_NAMES, accentFor, contrastRatio, mix, surfaceSteps, tokenVars } from "../../src/theme/tokens";

describe("theme tokens (DESIGN.md)", () => {
  test("five themes and five accents, Ink and Blue first", () => {
    expect(THEME_NAMES).toEqual(["ink", "graphite", "dusk", "paper", "contrast"]);
    expect(ACCENT_NAMES).toEqual(["blue", "teal", "amber", "rose", "mono"]);
    expect(THEMES.ink.canvas).toBe("#0E0E0D");
    expect(THEMES.ink.card).toBe("#141413");
    expect(THEMES.paper.raised).toBe("#EFECE4");
  });

  test("accents use the darker shade on Paper", () => {
    expect(accentFor("blue", "ink")).toBe("#4C8DFF");
    expect(accentFor("blue", "paper")).toBe("#2A63CC");
    expect(accentFor("mono", "paper")).toBe(ACCENTS.mono.light);
  });

  for (const theme of THEME_NAMES) {
    const t = THEMES[theme];
    test(`${theme}: every accent reads as text on card and canvas (4.5:1)`, () => {
      for (const accent of ACCENT_NAMES) {
        const a = accentFor(accent, theme);
        expect(contrastRatio(a, t.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(a, t.canvas)).toBeGreaterThanOrEqual(4.5);
      }
    });
    test(`${theme}: ink, body and mute text meet AA on card, canvas and raised`, () => {
      for (const bg of [t.card, t.canvas, t.raised]) {
        expect(contrastRatio(t.ink, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.body, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.mute, bg)).toBeGreaterThanOrEqual(4.5);
      }
    });
    test(`${theme}: sidebar and row steps keep text and focus rings readable`, () => {
      const s = surfaceSteps(theme);
      for (const bg of [s.side, s.fill]) {
        expect(contrastRatio(t.ink, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.mute, bg)).toBeGreaterThanOrEqual(4.5);
        for (const accent of ACCENT_NAMES) expect(contrastRatio(accentFor(accent, theme), bg)).toBeGreaterThanOrEqual(3);
      }
      expect(contrastRatio(t.ink, s.navOn)).toBeGreaterThanOrEqual(4.5);
    });
    test(`${theme}: primary button text meets AA`, () => {
      expect(contrastRatio(t.btnFg, t.btnBg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("tokenVars sets every surface, text and accent variable", () => {
    const vars = tokenVars("paper", "teal");
    expect(vars["--canvas"]).toBe("#F7F5EF");
    expect(vars["--accent"]).toBe("#0B7C73");
    expect(vars["--danger"]).toBe("#BC2E23");
    expect(vars["--accent-soft"]).toBe("rgba(11,124,115,0.1)");
    const dark = tokenVars("ink", "blue");
    expect(dark["--danger"]).toBe("#EE5A4B");
    expect(dark["--accent-soft"]).toBe("color-mix(in srgb, #4C8DFF 22%, #1A1A18)");
    for (const key of ["--card", "--raised", "--ink", "--body", "--mute", "--hair", "--hair-strong", "--btn-bg", "--btn-fg", "--ok", "--warn", "--pop"]) {
      expect(dark[key]).toBeTruthy();
    }
  });

  test("surface steps: sidebar lifts off the canvas and rows lift off the card", () => {
    expect(mix("#FFFFFF", 50, "#000000")).toBe("#808080");
    const ink = surfaceSteps("ink");
    expect(ink.side).toBe("#1C1C1A");
    expect(ink.fill).toBe("#212120");
    expect(surfaceSteps("paper")).toEqual({ side: "#EFECE4", fill: "#FFFFFF", fillHover: "#F6F6F6", navOn: "#DBD9D2" });
    expect(tokenVars("dusk", "blue")["--nav-on"]).toBe(surfaceSteps("dusk").navOn);
    for (const key of ["--side", "--fill", "--fill-hover", "--nav-on"]) expect(tokenVars("contrast", "mono")[key]).toBeTruthy();
  });

  test("contrastRatio composites translucent text over its background", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
    expect(contrastRatio("rgba(255,255,255,0)", "#000000")).toBeCloseTo(1, 1);
  });
});
