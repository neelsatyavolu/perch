import { expect, test } from "bun:test";
import { petalBurst, sakuraOn } from "../src/components/petals";
import { applyAppearance, lightPartner, shownTheme } from "../src/theme/theme";

const media = (dark: boolean, contrast = false) => (q: string) => ({ matches: q.includes("contrast") ? contrast : q.includes("dark") ? dark : false });

test("Match system pairs Yozakura with Sakura, every other dark theme with Paper", () => {
  expect(lightPartner("yozakura")).toBe("sakura");
  expect(lightPartner("ink")).toBe("paper");
  const a = { theme: "ink", matchSystem: true, darkTheme: "yozakura" };
  expect(shownTheme(a, (q) => media(false)(q).matches)).toBe("sakura");
  expect(shownTheme(a, (q) => media(true)(q).matches)).toBe("yozakura");
  expect(shownTheme(a, (q) => media(true, true)(q).matches)).toBe("contrast");
  expect(shownTheme({ ...a, darkTheme: "dusk" }, (q) => media(false)(q).matches)).toBe("paper");
});

test("the root gets the tone and, for Sakura's themes, the sakura flag", () => {
  const root = document.createElement("div");
  applyAppearance(root, { theme: "sakura", accent: "sakura", matchSystem: false, darkTheme: "ink" }, media(false));
  expect(root.dataset).toMatchObject({ theme: "sakura", tone: "light", accent: "sakura", sakura: "" });
  applyAppearance(root, { theme: "yozakura", accent: "blue", matchSystem: false, darkTheme: "ink" }, media(false));
  expect(root.dataset).toMatchObject({ theme: "yozakura", tone: "dark", sakura: "" });
  applyAppearance(root, { theme: "paper", accent: "blue", matchSystem: false, darkTheme: "ink" }, media(false));
  expect(root.dataset.tone).toBe("light");
  expect(root.dataset.sakura).toBeUndefined();
});

test("the petal burst only happens in Sakura mode, and never with Reduce Motion", () => {
  const button = document.createElement("button");
  document.body.appendChild(button);
  const count = () => document.querySelectorAll(".petal-burst").length;
  delete document.documentElement.dataset.sakura;
  petalBurst(button);
  expect(count()).toBe(0);
  document.documentElement.dataset.sakura = "";
  expect(sakuraOn()).toBe(true);
  const reduced = { ...window, document, matchMedia: (q: string) => ({ matches: q.includes("reduce") }) } as unknown as Window;
  petalBurst(button, reduced);
  expect(count()).toBe(0);
  const moving = { ...window, document, matchMedia: () => ({ matches: false }) } as unknown as Window;
  petalBurst(button, moving);
  expect(count()).toBe(6);
  for (const p of document.querySelectorAll(".petal-burst")) p.remove();
  delete document.documentElement.dataset.sakura;
  button.remove();
});
