/**
 * Smoke test: builds the pages with the fake backend, then loads every page in every theme in
 * headless Chrome for Testing (perchd's pipe launcher, no TCP debugging port). Each load must
 * have no console errors or exceptions, a main landmark and an h1, the theme's colours applied,
 * named buttons, and no sideways scrolling.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import type { CdpConnection } from "../../../perchd/src/cdp/connection";
import { findChromeForTesting, launchChromium } from "../../../perchd/src/cdp/pipe";
import { THEMES, THEME_NAMES } from "../../src/theme/tokens";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "dist-fake");
const PAGES = ["newtab", "settings", "settings#models", "settings#skills", "settings#privacy", "memory", "memory#setup", "routines", "import", "welcome"];

let server: ReturnType<typeof Bun.serve>;
let browser: CdpConnection;
let session = "";
let profile = "";
const problems: string[] = [];

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function evaluate<T>(expression: string): Promise<T> {
  const r = await browser.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression}`);
  return r.result.value;
}

async function load(url: string): Promise<void> {
  const loaded = new Promise<void>((resolve) => {
    const off = browser.on("Page.loadEventFired", (_p, sid) => {
      if (sid === session) {
        off();
        resolve();
      }
    });
  });
  await browser.send("Page.navigate", { url }, session);
  await loaded;
  for (let i = 0; i < 100; i++) {
    if (await evaluate<boolean>("!!document.querySelector('main h1, main [role=heading]') && !document.querySelector('[aria-busy=true]')")) return;
    await Bun.sleep(30);
  }
  throw new Error(`${url} never rendered its heading`);
}

beforeAll(async () => {
  const build = Bun.spawnSync(["nice", "-n", "10", join(ROOT, "node_modules/.bin/vite"), "build", "--mode", "fake", "--outDir", OUT, "--logLevel", "error"], { cwd: ROOT, stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`vite build failed: ${build.stderr.toString()}`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^\/+/, "");
      if (path.includes("..")) return new Response("no", { status: 400 });
      const file = Bun.file(join(OUT, path || "newtab.html"));
      return file.size ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  profile = mkdtempSync(join(tmpdir(), "perch-ui-smoke-"));
  browser = await launchChromium({ executable: await findChromeForTesting(), userDataDir: profile, headless: true });
  const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  ({ sessionId: session } = await browser.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
  await Promise.all(["Page.enable", "Runtime.enable", "Log.enable"].map((m) => browser.send(m, {}, session)));
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, session);
  browser.on("Runtime.exceptionThrown", (p) => problems.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
  browser.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "assert" || p.type === "warning") problems.push(`console.${p.type}: ${p.args?.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" ")}`);
  });
  browser.on("Log.entryAdded", (p) => {
    if (p.entry?.level === "error" || p.entry?.level === "warning") problems.push(`log ${p.entry.level}: ${p.entry.text} ${p.entry.url ?? ""}`);
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  if (profile) rmSync(profile, { recursive: true, force: true });
});

describe("every page in every theme", () => {
  for (const page of PAGES) {
    for (const theme of THEME_NAMES) {
      test(`${page} · ${theme}`, async () => {
        problems.length = 0;
        const [file, hash] = page.split("#");
        await load(`http://127.0.0.1:${server.port}/${file}.html?theme=${theme}${hash ? `#${hash}` : ""}`);
        await Bun.sleep(60);
        const facts = await evaluate<{ theme: string; bg: string; main: number; h1: number; unnamed: string[]; overflow: boolean; ids: string[] }>(`(() => {
          const named = (el) => (el.textContent || "").trim() || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.title;
          const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
          return {
            theme: document.documentElement.dataset.theme,
            bg: getComputedStyle(document.body).backgroundColor,
            main: document.querySelectorAll("main").length,
            h1: document.querySelectorAll("h1").length,
            unnamed: [...document.querySelectorAll("button, a[href], [role=switch], [role=radio], [role=tab]")].filter((b) => !named(b)).map((b) => b.outerHTML.slice(0, 80)),
            overflow: document.scrollingElement.scrollWidth > innerWidth,
            ids: ids.filter((id, i) => ids.indexOf(id) !== i),
          };
        })()`);
        expect(problems).toEqual([]);
        expect(facts.theme).toBe(theme);
        expect(facts.bg).toBe(hexToRgb(THEMES[theme].card));
        expect(facts.main).toBe(1);
        expect(facts.h1).toBe(1);
        expect(facts.unnamed).toEqual([]);
        expect(facts.overflow).toBe(false);
        expect(facts.ids).toEqual([]);
      }, 20_000);
    }
  }
});

async function pressTab(shift = false): Promise<void> {
  const key = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, session);
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, session);
}

describe("focus in a real browser", () => {
  test("the address box shows DESIGN.md's 2px accent ring with a 2px offset", async () => {
    await load(`http://127.0.0.1:${server.port}/newtab.html?theme=ink`);
    const ring = await evaluate<{ style: string; width: string; offset: string; color: string; accent: string }>(`(() => {
      document.querySelector(".box input").focus();
      const s = getComputedStyle(document.querySelector(".box"));
      return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() };
    })()`);
    expect(ring).toMatchObject({ style: "solid", width: "2px", offset: "2px" });
    expect(ring.color).toBe(hexToRgb(ring.accent));
  }, 20_000);

  test("Tab and Shift+Tab stay inside an open dialog; closing returns focus to its button", async () => {
    await load(`http://127.0.0.1:${server.port}/settings.html?theme=ink#skills`);
    const hasAdd = `[...document.querySelectorAll("button")].some((x) => x.textContent.trim() === "Add a server")`;
    for (let i = 0; i < 100 && !(await evaluate<boolean>(hasAdd)); i++) await Bun.sleep(30);
    await evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Add a server"); b.focus(); b.click(); })()`);
    await Bun.sleep(100);
    const inside = "!!document.activeElement && !!document.activeElement.closest('dialog[open]')";
    for (let i = 0; i < 14; i++) {
      await pressTab(i >= 10);
      expect(await evaluate<boolean>(inside)).toBe(true);
    }
    await evaluate(`document.querySelector("dialog[open] button[aria-label=Close]").click()`);
    await Bun.sleep(50);
    expect(await evaluate<string>("document.activeElement.textContent.trim()")).toBe("Add a server");
  }, 20_000);
});
