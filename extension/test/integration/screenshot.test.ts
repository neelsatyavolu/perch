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
