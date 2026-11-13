import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDesign, renderCss, renderNames } from "../scripts/gen-tokens";

const md = readFileSync(join(import.meta.dir, "..", "..", "DESIGN.md"), "utf8");
const design = parseDesign(md);

test("every theme and accent in DESIGN.md is read", () => {
  expect(design.themes.map((t) => t.name)).toEqual(["ink", "graphite", "dusk", "paper", "contrast", "sakura", "yozakura"]);
  expect(design.accents.map((a) => a.name)).toEqual(["blue", "teal", "amber", "rose", "mono", "sakura"]);
  // Light or dark comes from the canvas, so Sakura is light without being named anywhere.
  expect(design.themes.filter((t) => !t.dark).map((t) => t.name)).toEqual(["paper", "sakura"]);
  expect(design.accents.at(-1)).toEqual({ name: "sakura", dark: "#F5A3BC", light: "#B03762" });
  expect(design.themes[0]).toMatchObject({ canvas: "#0E0E0D", card: "#141413", raised: "#1A1A18", ink: "#F2F0EA", mute: "#8B8A87", btnBg: "#F2F0EA", btnFg: "#0E0E0D" });
  expect(design.themes[0]!.body).toBe("rgba(242, 240, 234, 0.86)");
  expect(design.themes[3]).toMatchObject({ name: "paper", dark: false, hair: "rgba(22, 22, 26, 0.1)", btnBg: "#16161A", btnFg: "#F7F5EF" });
  expect(design.accents[0]).toEqual({ name: "blue", dark: "#4C8DFF", light: "#2A63CC" });
  expect(design.danger).toEqual({ dark: "#EE5A4B", light: "#BC2E23" });
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

test("every theme gets the side, fill and current-row steps", () => {
  const css = renderCss(design);
  const blocks = css.split(":root[data-theme=").slice(1);
  expect(blocks).toHaveLength(7);
  for (const b of blocks) for (const v of ["--side:", "--fill:", "--fill-hover:", "--nav-on:", "--nav-ring:"]) expect(b).toContain(v);
  const contrast = blocks.find((b) => b.startsWith('"contrast"'))!;
  expect(contrast).toContain("--nav-ring: var(--hair-strong)");
  const paper = blocks.find((b) => b.startsWith('"paper"'))!;
  expect(paper).toContain("--side: var(--raised)");
  expect(blocks.find((b) => b.startsWith('"sakura"'))!).toContain("--side: var(--raised)");
  expect(css).toContain("--r-control: 8px; --r-panel: 12px; --r-chip: 8px; --r-composer: 16px;");
});
