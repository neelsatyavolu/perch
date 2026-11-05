import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDesign, renderCss, renderNames } from "../scripts/gen-tokens";

const md = readFileSync(join(import.meta.dir, "..", "..", "DESIGN.md"), "utf8");
const design = parseDesign(md);

test("every theme and accent in DESIGN.md is read", () => {
  expect(design.themes.map((t) => t.name)).toEqual(["ink", "graphite", "dusk", "paper", "contrast"]);
  expect(design.accents.map((a) => a.name)).toEqual(["blue", "teal", "amber", "rose", "mono"]);
  expect(design.themes[0]).toMatchObject({ canvas: "#000000", card: "#0E0E10", raised: "#1A1A1E", ink: "#FCFDFF", mute: "#A1A4A5", btnBg: "#FCFDFF", btnFg: "#000000" });
  expect(design.themes[0]!.body).toBe("rgba(252, 253, 255, 0.86)");
  expect(design.themes[3]).toMatchObject({ name: "paper", dark: false, hair: "rgba(0, 0, 0, 0.06)", btnBg: "#0A0A0C", btnFg: "#FFFFFF" });
  expect(design.accents[0]).toEqual({ name: "blue", dark: "#4C8DFF", light: "#2B68D6" });
  expect(design.danger).toEqual({ dark: "#FF453A", light: "#D92D3F" });
});

test("Paper uses the light accent shades and the 10% tint", () => {
  const css = renderCss(design);
  const paper = css.slice(css.indexOf(':root[data-theme="paper"]'), css.indexOf(':root[data-theme="contrast"]'));
  expect(paper).toContain("--accent: var(--accent-light)");
  expect(paper).toContain("10%");
  expect(paper).toContain("color-scheme: light");
});

test("the checked-in token files match DESIGN.md", () => {
  const root = join(import.meta.dir, "..", "src");
  expect(readFileSync(join(root, "styles", "tokens.css"), "utf8")).toBe(renderCss(design));
  expect(readFileSync(join(root, "theme", "names.gen.ts"), "utf8")).toBe(renderNames(design));
});

test("a DESIGN.md without the tables fails loudly", () => {
  expect(() => parseDesign("# nothing here\n")).toThrow(/Themes/);
});
