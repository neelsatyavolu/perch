import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tab } from "../../../perchd/src/browser/tab";
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
