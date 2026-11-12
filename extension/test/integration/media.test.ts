import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tab } from "../../../perchd/src/browser/tab";
import { setPlaybackRate } from "../../src/media/inject";
import { launch, waitFor, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

async function pressKey(tab: Tab, key: "[" | "]"): Promise<void> {
  const base = { key, code: key === "[" ? "BracketLeft" : "BracketRight", windowsVirtualKeyCode: key === "[" ? 219 : 221 };
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: key });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** A real click gives the page the user activation picture in picture asks for. */
async function clickPage(tab: Tab): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await tab.send("Input.dispatchMouseEvent", { type, x: 700, y: 40, button: "left", clickCount: 1 });
  }
}

async function videoTab(): Promise<Tab> {
  const tab = await h.open(h.site.url("site.localhost", "/video.html"));
  expect(await tab.evaluate<boolean>("playVideo()")).toBe(true);
  await waitFor(() => tab.evaluate<boolean>("v.readyState >= 2 && !v.paused"), "the video to play");
  return tab;
}

describe("playback speed keys", () => {
  test("] and [ step the playing video's speed by 0.25", async () => {
    const tab = await videoTab();
    await pressKey(tab, "]");
    await pressKey(tab, "]");
    expect(await tab.evaluate<number>("v.playbackRate")).toBe(1.5);
    await pressKey(tab, "[");
    await pressKey(tab, "[");
    await pressKey(tab, "[");
    expect(await tab.evaluate<number>("v.playbackRate")).toBe(0.75);
    await tab.close();
  });

  test("typing [ or ] in a text field leaves the speed alone", async () => {
    const tab = await videoTab();
    await tab.evaluate("document.getElementById('field').focus()");
    await pressKey(tab, "]");
    expect(await tab.evaluate<number>("v.playbackRate")).toBe(1);
    expect(await tab.evaluate<string>("document.getElementById('field').value")).toBe("]");
    await tab.close();
  });
});

describe("picture in picture", () => {
  test("a playing video with sound moves into picture in picture when its tab is hidden, and back when shown", async () => {
    const tab = await videoTab();
    await tab.evaluate("v.muted = false");
    await clickPage(tab);
    const tabId = await h.tabIdOf(tab);
    const other = await h.sw<number>(
      `chrome.tabs.get(${tabId}).then((t) => chrome.tabs.create({ windowId: t.windowId, url: "about:blank", active: true })).then((t) => t.id)`,
    );
    await waitFor(() => tab.evaluate<boolean>("pipLog.includes('enter')"), "picture in picture to start");
    await h.sw(`chrome.tabs.update(${tabId}, { active: true })`);
    await waitFor(() => tab.evaluate<boolean>("pipLog.includes('leave')"), "picture in picture to end");
    await h.sw(`chrome.tabs.remove(${other})`);
    await tab.close();
  });

  test("a muted video stays in the page when its tab is hidden", async () => {
    const tab = await videoTab();
    await clickPage(tab);
    const tabId = await h.tabIdOf(tab);
    const other = await h.sw<number>(
      `chrome.tabs.get(${tabId}).then((t) => chrome.tabs.create({ windowId: t.windowId, url: "about:blank", active: true })).then((t) => t.id)`,
    );
    await waitFor(() => tab.evaluate<boolean>("document.hidden"), "the tab to be hidden");
    await Bun.sleep(500);
    expect(await tab.evaluate<string[]>("pipLog")).toEqual([]);
    await h.sw(`chrome.tabs.remove(${other})`);
    await tab.close();
  });
});

describe("picture in picture and speed from the panel and menus", () => {
  // The worker runs the same functions for menus and shortcuts (routes in test/unit/menus.test.ts).
  // A command's gesture cannot be simulated in the worker through CDP, so picture in picture is
  // checked here from the panel, whose real click carries the gesture the same way.
  const inject = (tabId: number, func: string, target: string, args = "[]") =>
    h.sw(`chrome.scripting.executeScript({ target: { tabId: ${tabId}, ${target} }, func: ${func}, args: ${args} }).then(() => true)`);

  test("the panel's Picture in picture button starts it: the click's gesture reaches the page", async () => {
    const tab = await videoTab();
    const tabId = await h.tabIdOf(tab);
    const panel = await h.extensionPage(`popup.html?tabId=${tabId}`);
    const point = await waitFor(
      () =>
        panel.evaluate<{ x: number; y: number } | null>(
          `(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent === "Pop out video"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
        ),
      "the panel's button",
    );
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await panel.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    }
    await waitFor(() => tab.evaluate<boolean>("pipLog.includes('enter')"), "picture in picture to start");
    await panel.close();
    await tab.close();
  }, 20_000);

  test("the Playback speed menu sets the clicked video's rate", async () => {
    const tab = await videoTab();
    const tabId = await h.tabIdOf(tab);
    const src = await tab.evaluate<string>("v.currentSrc");
    await inject(tabId, setPlaybackRate.toString(), "frameIds: [0]", JSON.stringify([src, 1.75]));
    expect(await tab.evaluate<number>("v.playbackRate")).toBe(1.75);
    await tab.close();
  });
});

describe("Copy link without tracking", () => {
  test("the offscreen document writes the cleaned address to the clipboard", async () => {
    const page = await h.open(h.site.url("site.localhost", "/plain.html"));
    await h.browser.conn.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: h.site.url("site.localhost", "").replace(/\/$/, "") });
    const reply = await h.sw<{ ok: boolean }>(
      `chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "test" })` +
        `.then(() => chrome.runtime.sendMessage({ target: "offscreen", type: "copy", text: "https://a.example/story?id=4" }))`,
    );
    expect(reply.ok).toBe(true);
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe("https://a.example/story?id=4");
    await page.close();
  }, 20_000);
});

