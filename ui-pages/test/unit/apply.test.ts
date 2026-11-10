import { describe, expect, test } from "bun:test";
import { DEFAULT_APPEARANCE, applyAppearance, cacheAppearance, readCachedAppearance, resolveTheme } from "../../src/theme/apply";

const light = { prefersDark: false, prefersMoreContrast: false };
const dark = { prefersDark: true, prefersMoreContrast: false };

describe("resolveTheme", () => {
  test("uses the chosen theme when Match system is off", () => {
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, theme: "dusk" }, light)).toBe("dusk");
  });
  test("Match system switches between the chosen dark theme and Paper", () => {
    const a = { ...DEFAULT_APPEARANCE, matchSystem: true, darkTheme: "graphite" as const };
    expect(resolveTheme(a, dark)).toBe("graphite");
    expect(resolveTheme(a, light)).toBe("paper");
  });
  test("macOS Increase Contrast turns on Contrast", () => {
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, theme: "paper" }, { prefersDark: false, prefersMoreContrast: true })).toBe("contrast");
  });
});

describe("applyAppearance", () => {
  test("writes tokens, theme name, colour scheme and density on the root", () => {
    const root = document.createElement("div");
    applyAppearance(root, { ...DEFAULT_APPEARANCE, theme: "paper", accent: "rose", density: "compact" }, light);
    expect(root.style.getPropertyValue("--canvas")).toBe("#F7F5EF");
    expect(root.style.getPropertyValue("--accent")).toBe("#C93558");
    expect(root.dataset.theme).toBe("paper");
    expect(root.dataset.density).toBe("compact");
    expect(root.style.colorScheme).toBe("light");
  });
});

describe("appearance cache", () => {
  test("round-trips and rejects junk", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    cacheAppearance({ ...DEFAULT_APPEARANCE, theme: "dusk" }, storage);
    expect(readCachedAppearance(storage).theme).toBe("dusk");
    store.set("perch.appearance", '{"theme":"purple","accent":"blue"}');
    expect(readCachedAppearance(storage)).toEqual(DEFAULT_APPEARANCE);
    store.set("perch.appearance", "not json");
    expect(readCachedAppearance(storage)).toEqual(DEFAULT_APPEARANCE);
  });
});
