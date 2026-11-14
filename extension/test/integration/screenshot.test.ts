import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Tab } from "../../../perchd/src/browser/tab";
import { launch, waitFor, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

type Pixel = [number, number, number];

/** Asks the service worker for a capture the way the panel does, then attaches to the markup page it opens. */
async function capture(path: string): Promise<{ page: Tab; shot: Tab; viewport: { width: number; height: number; dpr: number } }> {
  const page = await h.open(h.site.url("site.localhost", path));
  const tabId = await h.tabIdOf(page);
  const viewport = await page.evaluate<{ width: number; height: number; dpr: number }>(
    "({ width: document.documentElement.clientWidth, height: innerHeight, dpr: devicePixelRatio })",
  );
  const panel = await h.extensionPage("options.html");
  const reply = await panel.evaluate<{ ok: boolean; value?: string; error?: string }>(`chrome.runtime.sendMessage({ type: "screenshot", tabId: ${tabId} })`);
  await panel.close();
  expect(reply.ok).toBe(true);
  const shotUrl = `chrome-extension://${h.extensionId}/shot.html?id=${reply.value}`;
  const target = await waitFor(async () => (await h.browser.tabs()).find((t) => t.url === shotUrl) ?? null, "the screenshot page");
  const shot = await Tab.attach(h.browser.conn, target.id);
  await waitFor(() => shot.evaluate<boolean>("document.getElementById('canvas').dataset.ready === 'true'"), "the image to load");
  return { page, shot, viewport };
}

const pixelAt = (shot: Tab, cssY: number, dpr: number) =>
  shot.evaluate<Pixel>(
    `Array.from(document.getElementById('canvas').getContext('2d').getImageData(20, ${Math.round(cssY * dpr)}, 1, 1).data.slice(0, 3))`,
  );

const near = (actual: Pixel, expected: Pixel) => actual.every((v, i) => Math.abs(v - expected[i]!) <= 8);

describe("full-page screenshot", () => {
  test("stitches the whole page into one image at the page's full height", async () => {
    const { page, shot, viewport } = await capture("/long.html");
    const size = await shot.evaluate<{ width: number; height: number }>("({ width: canvas.width, height: canvas.height })");
    expect(size.width).toBe(Math.round(viewport.width * viewport.dpr));
    expect(size.height).toBe(Math.round(3000 * viewport.dpr));
    expect(near(await pixelAt(shot, 150, viewport.dpr), [220, 0, 0])).toBe(true);
    expect(near(await pixelAt(shot, 2850, viewport.dpr), [0, 0, 220])).toBe(true);
    await shot.close();
    await page.close();
  }, 20_000);

  test("a fixed header appears once, at the top, not on every strip", async () => {
    const { page, shot, viewport } = await capture("/long.html");
    expect(near(await pixelAt(shot, 20, viewport.dpr), [0, 160, 0])).toBe(true);
    expect(near(await pixelAt(shot, viewport.height + 20, viewport.dpr), [255, 255, 255])).toBe(true);
    await shot.close();
    await page.close();
  }, 20_000);

  test("a sticky element shows where it sits in the page, once, and gets its own styles back", async () => {
    const { page, shot, viewport } = await capture("/sticky.html");
    // The sticky nav is at the top and does not repeat on the next strip.
    expect(near(await pixelAt(shot, 20, viewport.dpr), [0, 160, 0])).toBe(true);
    expect(near(await pixelAt(shot, viewport.height + 20, viewport.dpr), [255, 255, 255])).toBe(true);
    // The note sits at 1200–1300 in the page; its top: 60px does not push it down.
    expect(near(await pixelAt(shot, 1210, viewport.dpr), [240, 140, 0])).toBe(true);
    expect(near(await pixelAt(shot, 1340, viewport.dpr), [255, 255, 255])).toBe(true);
    expect(await page.evaluate<string>("document.querySelector('.note').getAttribute('style')")).toBe("top: 60px;");
    expect(await page.evaluate<string>("getComputedStyle(document.querySelector('nav')).position")).toBe("sticky");
    expect(await page.evaluate<number>("document.querySelectorAll('[data-perch-shot-sticky]').length")).toBe(0);
    await shot.close();
    await page.close();
  }, 20_000);

  test("the pen and box draw on the image, and Undo takes the last mark off", async () => {
    const { page, shot, viewport } = await capture("/long.html");
    const rect = await shot.evaluate<{ x: number; y: number; width: number; scale: number }>(
      "(() => { const r = canvas.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, scale: canvas.width / r.width }; })()",
    );
    // At page y 300 the capture is white; draw across it.
    const y = rect.y + (300 * viewport.dpr) / rect.scale;
    const drag = async (from: number, to: number, dy = 0) => {
      await shot.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from, y, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) await shot.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from + ((to - from) * i) / 8, y: y + (dy * i) / 8, button: "left", buttons: 1 });
      await shot.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to, y: y + dy, button: "left", buttons: 0, clickCount: 1 });
    };
    const at = (cssX: number, cssY: number) =>
      shot.evaluate<Pixel>(
        `Array.from(canvas.getContext('2d').getImageData(${Math.round((cssX - rect.x) * rect.scale)}, ${Math.round((cssY - rect.y) * rect.scale)}, 1, 1).data.slice(0, 3))`,
      );
    const isMark = (p: Pixel) => p[2] > p[0] + 60;
    const left = rect.x + rect.width * 0.2;
    const right = rect.x + rect.width * 0.6;
    await drag(left, right);
    expect(isMark(await at((left + right) / 2, y))).toBe(true);
    await shot.evaluate("document.getElementById('box').click()");
    await drag(left, right, 40);
    await waitFor(async () => isMark(await at(right, y + 20)), "the box's right edge");
    await shot.evaluate("document.getElementById('undo').click()");
    expect(isMark(await at(right, y + 20))).toBe(false);
    expect(isMark(await at((left + right) / 2, y))).toBe(true);
    await shot.close();
    await page.close();
  }, 20_000);

  test("puts the page back as it was: scroll position and fixed elements", async () => {
    const page = await h.open(h.site.url("site.localhost", "/long.html"));
    await page.evaluate("scrollTo(0, 700)");
    const tabId = await h.tabIdOf(page);
    const panel = await h.extensionPage("options.html");
    const reply = await panel.evaluate<{ ok: boolean; value: string }>(`chrome.runtime.sendMessage({ type: "screenshot", tabId: ${tabId} })`);
    await panel.close();
    expect(reply.ok).toBe(true);
    expect(await page.evaluate<number>("scrollY")).toBe(700);
    expect(await page.evaluate<string>("getComputedStyle(document.querySelector('header')).visibility")).toBe("visible");
    expect(await page.evaluate<number>("document.querySelectorAll('[data-perch-shot-hidden]').length")).toBe(0);
    await page.close();
  }, 20_000);

  test("a second request while one is running is refused, and the page is put back once", async () => {
    const page = await h.open(h.site.url("site.localhost", "/long.html"));
    await page.evaluate("scrollTo(0, 300)");
    const tabId = await h.tabIdOf(page);
    const panel = await h.extensionPage("options.html");
    const replies = await panel.evaluate<{ ok: boolean; value?: string; error?: string }[]>(
      `Promise.all([1, 2].map(() => chrome.runtime.sendMessage({ type: "screenshot", tabId: ${tabId} })))`,
    );
    await panel.close();
    expect(replies.filter((r) => r.ok)).toHaveLength(1);
    expect(replies.find((r) => !r.ok)?.error).toBe("A screenshot is already being taken. Wait for it to finish.");
    expect(await page.evaluate<string>("getComputedStyle(document.querySelector('header')).visibility")).toBe("visible");
    expect(await page.evaluate<number>("document.querySelectorAll('[data-perch-shot-hidden]').length")).toBe(0);
    expect(await page.evaluate<number>("scrollY")).toBe(300);
    const shotUrl = `chrome-extension://${h.extensionId}/shot.html?id=${replies.find((r) => r.ok)!.value}`;
    const target = await waitFor(async () => (await h.browser.tabs()).find((t) => t.url === shotUrl) ?? null, "the screenshot page");
    await (await Tab.attach(h.browser.conn, target.id)).close();
    await page.close();
  }, 20_000);

  test("a second screenshot while the first one's page is still open; each link opens once", async () => {
    const { page, shot, viewport } = await capture("/long.html");
    expect(near(await pixelAt(shot, 2850, viewport.dpr), [0, 0, 220])).toBe(true);
    const url = await shot.url();
    await shot.navigate(url);
    const status = await waitFor(() => shot.evaluate<string>("document.getElementById('status').textContent"), "status");
    expect(status).toBe("This screenshot is no longer available. Take a new one from the page.");
    await shot.close();
    await page.close();
  }, 20_000);

  test("content scripts cannot ask for a screenshot", async () => {
    const page = await h.open(h.site.url("site.localhost", "/plain.html"));
    const tabId = await h.tabIdOf(page);
    const [result] = await h.sw<{ result: unknown }[]>(
      `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: "ISOLATED", func: (id) => chrome.runtime.sendMessage({ type: "screenshot", tabId: id }).then((r) => r ?? "no reply", (e) => String(e)), args: [${tabId}] })`,
    );
    expect(JSON.stringify(result!.result)).not.toContain('"ok":true');
    await page.close();
  }, 20_000);
});
