import { describe, expect, test } from "bun:test";
import { bookmarkId, bookmarksAdapter, emptyBrowserState, historyAdapter, tabsAdapter, type BrowserSyncState } from "../src/sync/browser-adapters";
import type { SyncedItem } from "../src/sync/engine";
import { fakeBrowser } from "./fake-browser-data";

function holder(initial: BrowserSyncState = emptyBrowserState) {
  let state = initial;
  return { get: () => state, set: (s: BrowserSyncState) => (state = s) };
}

const now = () => 1_000;

describe("bookmarks adapter", () => {
  test("new, renamed and removed bookmarks become changes, once", async () => {
    const b = fakeBrowser();
    const s = holder();
    const a = bookmarksAdapter(b.domain, s, now);
    b.addBookmark(0, "Example", "https://example.com/");
    const first = await a.changes();
    expect(first.length).toBe(1);
    expect(first[0]!.data).toEqual({ path: ["Bookmarks bar"], title: "Example", url: "https://example.com/" });
    await a.pushed(first);
    expect(await a.changes()).toEqual([]);

    b.roots[0]!.children![0]!.title = "Renamed";
    const renamed = await a.changes();
    expect(renamed.map((c) => [c.naturalId, (c.data as { title: string }).title])).toEqual([[first[0]!.naturalId, "Renamed"]]);
    await a.pushed(renamed);

    b.roots[0]!.children!.splice(0, 1);
    const removed = await a.changes();
    expect(removed).toEqual([{ naturalId: first[0]!.naturalId, updatedAt: 1_000, deleted: true }]);
  });

  test("remote bookmarks are added under their folders, and are not sent back", async () => {
    const b = fakeBrowser();
    const s = holder();
    const a = bookmarksAdapter(b.domain, s, now);
    const path = ["Other bookmarks", "Work", "Docs"];
    const id = bookmarkId(path, "https://spec.example/");
    const item: SyncedItem = { naturalId: id, updatedAt: 5, deviceId: "dev_other", deleted: false, data: { path: ["Other bookmarks", "Work", "Docs"], title: "Spec", url: "https://spec.example/" } };
    await a.apply([item], []);
    const work = b.roots[1]!.children!.find((n) => n.title === "Work")!;
    const docs = work.children!.find((n) => n.title === "Docs")!;
    expect(docs.children!.map((n) => n.url)).toEqual(["https://spec.example/"]);
    expect(await a.changes()).toEqual([]);

    // Removed on the other device.
    await a.apply([{ naturalId: id, updatedAt: 6, deviceId: "dev_other", deleted: true }], []);
    expect(docs.children).toEqual([]);
    expect(await a.changes()).toEqual([]);
  });
});

describe("history adapter", () => {
  test("sends visits since the last push, grouped by address", async () => {
    const b = fakeBrowser();
    const s = holder();
    const a = historyAdapter(b.domain, s);
    b.visits.push({ url: "https://a.example/", title: "A", time: 10 }, { url: "https://a.example/", title: "A", time: 20 }, { url: "https://b.example/", title: "B", time: 15 });
    const changes = await a.changes();
    expect(changes.map((c) => c.data)).toEqual([
      { url: "https://a.example/", title: "A", visits: [10, 20] },
      { url: "https://b.example/", title: "B", visits: [15] },
    ]);
    await a.pushed(changes);
    expect(s.get().historySince).toBe(20);
    expect(await a.changes()).toEqual([]);
  });

  test("adds other devices' visits to the browser", async () => {
    const b = fakeBrowser();
    const a = historyAdapter(b.domain, holder());
    await a.apply([{ naturalId: "h", updatedAt: 1, deviceId: "d", deleted: false, data: { url: "https://c.example/", title: "C", visits: [3, 4] } }], []);
    expect(b.added).toEqual([{ url: "https://c.example/", title: "C", time: 3 }, { url: "https://c.example/", title: "C", time: 4 }]);
  });
});

describe("tabs adapter", () => {
  test("sends this device's open tabs, never private windows, and keeps other devices' tabs", async () => {
    const b = fakeBrowser();
    const s = holder();
    const a = tabsAdapter(b.domain, s, "dev_me", now);
    b.setWindows([
      { windowId: "w1", incognito: false, tabs: [{ tabId: "t1", url: "https://a.example/", title: "A", pinned: true }], groups: [], splits: [] },
      { windowId: "w2", incognito: true, tabs: [{ tabId: "t2", url: "https://secret.example/", title: "S", pinned: false }], groups: [], splits: [] },
    ]);
    const changes = await a.changes();
    expect(changes.length).toBe(1);
    expect(JSON.stringify(changes[0]!.data)).not.toContain("secret.example");
    await a.pushed(changes);
    expect(await a.changes()).toEqual([]);

    await a.apply([{ naturalId: "device:dev_laptop", updatedAt: 9, deviceId: "dev_laptop", deleted: false, data: { windows: [{ tabs: [{ url: "https://l.example/", title: "L", pinned: false }], groups: [] }] } }], []);
    expect(s.get().remoteTabs.dev_laptop?.windows[0]?.tabs[0]?.url).toBe("https://l.example/");
  });
});
