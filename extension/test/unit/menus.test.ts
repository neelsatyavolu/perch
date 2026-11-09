import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { onCommand, onMenuClick } from "../../src/background/menus";
import { setPlaybackRate, togglePictureInPicture } from "../../src/media/inject";

type Call = { api: string; arg: unknown };

/** Just enough of the chrome API for the menu and command routes, recording every call. */
function fakeChrome(calls: Call[]) {
  const record = (api: string, value: unknown = undefined) => async (arg: unknown) => {
    calls.push({ api, arg });
    return value;
  };
  return {
    scripting: { executeScript: record("executeScript", [{ result: "entered" }]) },
    tabs: { query: record("tabs.query", [{ id: 7 }]) },
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      getContexts: record("getContexts", []),
      sendMessage: record("sendMessage", { ok: true }),
    },
    offscreen: { Reason: { CLIPBOARD: "CLIPBOARD" }, createDocument: record("createDocument") },
  };
}

let calls: Call[];
beforeEach(() => {
  calls = [];
  (globalThis as { chrome?: unknown }).chrome = fakeChrome(calls);
});
afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

const tab = { id: 3 } as chrome.tabs.Tab;
const click = (data: Partial<chrome.contextMenus.OnClickData>) => onMenuClick({ editable: false, pageUrl: "https://a.example/", ...data } as chrome.contextMenus.OnClickData, tab);

describe("video menu", () => {
  test("Playback speed sets the clicked video's rate in the frame it was clicked in", async () => {
    await click({ menuItemId: "speed:1.5", frameId: 2, srcUrl: "https://a.example/v.webm" });
    expect(calls).toEqual([
      { api: "executeScript", arg: { target: { tabId: 3, frameIds: [2] }, func: setPlaybackRate, args: ["https://a.example/v.webm", 1.5] } },
    ]);
  });

  test("a speed that is not on the menu is ignored", async () => {
    await click({ menuItemId: "speed:16" });
    expect(calls).toEqual([]);
  });

  test("Picture in picture runs in every frame from the click, which carries the user's gesture", async () => {
    await click({ menuItemId: "pip" });
    expect(calls).toEqual([{ api: "executeScript", arg: { target: { tabId: 3, allFrames: true }, func: togglePictureInPicture } }]);
  });
});

describe("link menu", () => {
  test("Copy link without tracking copies the cleaned address through the offscreen document", async () => {
    await click({ menuItemId: "copy-clean", linkUrl: "https://a.example/story?id=4&utm_source=news&fbclid=abc" });
    expect(calls.map((c) => c.api)).toEqual(["getContexts", "createDocument", "sendMessage"]);
    expect(calls[2]!.arg).toEqual({ target: "offscreen", type: "copy", text: "https://a.example/story?id=4" });
  });
});

describe("keyboard commands", () => {
  test("the picture in picture shortcut acts on the active tab when Chrome names none", async () => {
    await onCommand("pip");
    expect(calls.map((c) => c.api)).toEqual(["tabs.query", "executeScript"]);
    expect(calls[1]!.arg).toEqual({ target: { tabId: 7, allFrames: true }, func: togglePictureInPicture });
  });
});
