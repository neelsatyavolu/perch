import { expect, test } from "bun:test";
import { sharedPinsOnce } from "../../src/import/chrome/snss";
import type { SessionTab, SessionWindow } from "../../src/import/types";

const tab = (url: string): SessionTab => ({ url, title: url, pinned: false });
const pin = (url: string, home: string): SessionTab => ({ url, title: home, pinned: true, pinnedHome: home });
const win = (...tabs: SessionTab[]): SessionWindow => ({ tabs, selected: 0, groups: [] });

test("shared pins come over once, at their home address, and a pin only one window still has is dropped", () => {
  const out = sharedPinsOnce([
    win(pin("https://a.test/deep", "https://a.test/"), pin("https://stale.test/x", "https://stale.test/"), tab("https://one.test/")),
    win(pin("https://a.test/other", "https://a.test/"), tab("https://two.test/")),
  ]);
  expect(out.map((w) => w.tabs.map((t) => `${t.pinned ? "pin " : ""}${t.url}`))).toEqual([["pin https://a.test/", "https://one.test/"], ["https://two.test/"]]);
});

test("ordinary pinned tabs, with no home address, are left alone", () => {
  const windows = [win({ url: "https://a.test/", title: "A", pinned: true }, tab("https://b.test/")), win({ url: "https://a.test/", title: "A", pinned: true })];
  expect(sharedPinsOnce(windows)).toEqual(windows);
});

test("a window left with nothing after its shared pins move is not imported", () => {
  const out = sharedPinsOnce([win(pin("https://a.test/1", "https://a.test/"), tab("https://one.test/")), win(pin("https://a.test/2", "https://a.test/"))]);
  expect(out).toHaveLength(1);
});
