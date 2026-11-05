import { describe, expect, test } from "bun:test";
import { ACCENTS, ACCENT_NAMES, THEMES, THEME_NAMES, accentFor, contrastRatio, tokenVars } from "../../src/theme/tokens";

describe("theme tokens (DESIGN.md)", () => {
  test("five themes and five accents, Ink and Blue first", () => {
    expect(THEME_NAMES).toEqual(["ink", "graphite", "dusk", "paper", "contrast"]);
    expect(ACCENT_NAMES).toEqual(["blue", "teal", "amber", "rose", "mono"]);
    expect(THEMES.ink.canvas).toBe("#000000");
    expect(THEMES.ink.card).toBe("#0E0E10");
    expect(THEMES.paper.raised).toBe("#ECEEF1");
  });

  test("accents use the darker shade on Paper", () => {
    expect(accentFor("blue", "ink")).toBe("#4C8DFF");
    expect(accentFor("blue", "paper")).toBe("#2B68D6");
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
    test(`${theme}: primary button text meets AA`, () => {
      expect(contrastRatio(t.btnFg, t.btnBg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("tokenVars sets every surface, text and accent variable", () => {
    const vars = tokenVars("paper", "teal");
    expect(vars["--canvas"]).toBe("#F4F5F7");
    expect(vars["--accent"]).toBe("#0B7C73");
    expect(vars["--danger"]).toBe("#D92D3F");
    expect(vars["--accent-soft"]).toBe("rgba(11,124,115,0.1)");
    const dark = tokenVars("ink", "blue");
    expect(dark["--danger"]).toBe("#FF453A");
    expect(dark["--accent-soft"]).toBe("color-mix(in srgb, #4C8DFF 22%, #1A1A1E)");
    for (const key of ["--card", "--raised", "--ink", "--body", "--mute", "--hair", "--hair-strong", "--btn-bg", "--btn-fg", "--ok", "--warn", "--pop"]) {
      expect(dark[key]).toBeTruthy();
    }
  });

  test("contrastRatio composites translucent text over its background", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
    expect(contrastRatio("rgba(255,255,255,0)", "#000000")).toBeCloseTo(1, 1);
  });
});
