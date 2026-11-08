/**
 * Sync adapters over the browser's own stores (plan 3b task 14): bookmarks, history and open tabs,
 * read and written through the `Perch` CDP domain. Each adapter compares what the browser has now
 * with what was last pushed (kept in BrowserSyncState, which the caller stores sealed), so only
 * edits go out, and what other devices changed is written back without being sent again.
 *
 * Ids are the same on every device: a bookmark is its folder path and address, history is its
 * address, and open tabs are one item per device. Private (incognito) windows never sync.
 */

import { createHash } from "node:crypto";
import type { BookmarkChange, BookmarkNode, OpenWindow, PerchDomainApi } from "../browser/perch-domain";
import type { LocalChange, SyncedItem } from "./engine";
import type { HistoryEntry } from "./merge";
import type { SyncAdapter } from "./runner";

export type SyncedTabs = { windows: { tabs: { url: string; title: string; pinned: boolean; groupId?: string }[]; groups: { groupId: string; title: string; color: string }[] }[] };

export type BrowserSyncState = {
  /** Bookmark id → fingerprint of what was last pushed or applied. */
  readonly bookmarks: Readonly<Record<string, string>>;
  /** History visits up to this time (ms) have been pushed. */
  readonly historySince: number;
  /** Fingerprint of this device's open tabs as last pushed. */
  readonly tabs: string;
  /** Other devices' open tabs, by device id. */
  readonly remoteTabs: Readonly<Record<string, SyncedTabs & { updatedAt: number }>>;
};

export const emptyBrowserState: BrowserSyncState = { bookmarks: {}, historySince: 0, tabs: "", remoteTabs: {} };

/** Where an adapter reads and writes its part of the state. */
export type StateCell = { get(): BrowserSyncState; set(state: BrowserSyncState): void };

type Domain = Pick<PerchDomainApi, "getBookmarks" | "applyBookmarkChanges" | "getHistory" | "addHistory" | "getOpenTabs">;

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

export const bookmarkId = (path: readonly string[], url: string) => `b-${hash(`${path.join("\u001f")}\u001e${url}`)}`;
export const historyId = (url: string) => `h-${hash(url)}`;

type BookmarkData = { path: string[]; title: string; url: string };
type LocalBookmark = BookmarkData & { id: string; nodeId: string };

const isBookmarkData = (d: unknown): d is BookmarkData =>
  typeof d === "object" && d !== null && Array.isArray((d as BookmarkData).path) && (d as BookmarkData).path.every((p) => typeof p === "string") &&
  typeof (d as BookmarkData).title === "string" && typeof (d as BookmarkData).url === "string" && /^https?:\/\//i.test((d as BookmarkData).url);

const fingerprint = (d: BookmarkData) => hash(JSON.stringify([d.path, d.title, d.url]));

function flatten(roots: readonly BookmarkNode[]): Map<string, LocalBookmark> {
  const out = new Map<string, LocalBookmark>();
  const walk = (nodes: readonly BookmarkNode[], path: string[]) => {
    for (const n of nodes) {
      if (n.url !== undefined) {
        if (!/^https?:\/\//i.test(n.url)) continue;
        const id = bookmarkId(path, n.url);
        if (!out.has(id)) out.set(id, { id, nodeId: n.id, path, title: n.title, url: n.url });
      } else walk(n.children ?? [], [...path, n.title]);
    }
  };
  for (const root of roots) walk(root.children ?? [], [root.title]);
  return out;
}

export function bookmarksAdapter(domain: Domain, cell: StateCell, now: () => number = Date.now): SyncAdapter {
  const read = async () => flatten((await domain.getBookmarks())?.roots ?? []);

  /** The folder for a path, made where missing. Returns its node id, or null when no root matches. */
  async function folderFor(path: readonly string[]): Promise<string | null> {
    const roots = (await domain.getBookmarks())?.roots ?? [];
    const root = roots.find((r) => r.title === path[0]) ?? roots[1] ?? roots[0];
    if (!root) return null;
    let node = root;
    for (const title of path.slice(1)) {
      const found = (node.children ?? []).find((c) => c.url === undefined && c.title === title);
      if (found) {
        node = found;
        continue;
      }
      const made = await domain.applyBookmarkChanges({ changes: [{ op: "add", parentId: node.id, title }] });
      const id = made?.idMap?.[0];
      if (!id) return null;
      node = { id, title, children: [] };
    }
    return node.id;
  }

  return {
    collection: "bookmarks",
    async changes() {
      const local = await read();
      const seen = cell.get().bookmarks;
      const out: LocalChange[] = [];
      for (const b of local.values()) {
        const data: BookmarkData = { path: b.path, title: b.title, url: b.url };
        if (seen[b.id] !== fingerprint(data)) out.push({ naturalId: b.id, updatedAt: now(), data });
      }
      for (const id of Object.keys(seen)) if (!local.has(id)) out.push({ naturalId: id, updatedAt: now(), deleted: true });
      return out;
    },
    async pushed(sent) {
      const next = { ...cell.get().bookmarks };
      for (const c of sent) {
        if (c.deleted) delete next[c.naturalId];
        else if (isBookmarkData(c.data)) next[c.naturalId] = fingerprint(c.data);
      }
      cell.set({ ...cell.get(), bookmarks: next });
    },
    async apply(items) {
      const next = { ...cell.get().bookmarks };
      let local = await read();
      for (const item of items) {
        const mine = local.get(item.naturalId);
        if (item.deleted || !isBookmarkData(item.data)) {
          if (item.deleted && mine) await domain.applyBookmarkChanges({ changes: [{ op: "remove", id: mine.nodeId }] });
          if (item.deleted) delete next[item.naturalId];
          continue;
        }
        const data = item.data;
        let change: BookmarkChange | null = null;
        if (mine) {
          if (mine.title !== data.title) change = { op: "update", id: mine.nodeId, title: data.title };
        } else {
          const parentId = await folderFor(data.path);
          if (parentId) change = { op: "add", parentId, title: data.title, url: data.url };
        }
        if (change) await domain.applyBookmarkChanges({ changes: [change] });
        next[item.naturalId] = fingerprint(data);
        local = await read();
      }
      cell.set({ ...cell.get(), bookmarks: next });
    },
  };
}

const isHistoryEntry = (d: unknown): d is HistoryEntry =>
  typeof d === "object" && d !== null && typeof (d as HistoryEntry).url === "string" && Array.isArray((d as HistoryEntry).visits) && (d as HistoryEntry).visits.every((v) => typeof v === "number");

export function historyAdapter(domain: Domain, cell: StateCell): SyncAdapter {
  return {
    collection: "history",
    async changes() {
      const visits = (await domain.getHistory({ since: cell.get().historySince }))?.visits ?? [];
      const byUrl = new Map<string, HistoryEntry>();
      for (const v of visits) {
        if (!/^https?:\/\//i.test(v.url)) continue;
        const entry = byUrl.get(v.url);
        byUrl.set(v.url, entry ? { ...entry, title: v.title || entry.title, visits: [...entry.visits, v.time] } : { url: v.url, title: v.title, visits: [v.time] });
      }
      return [...byUrl.values()].map((e): LocalChange => {
        const sorted = [...e.visits].sort((a, b) => a - b);
        return { naturalId: historyId(e.url), updatedAt: sorted.at(-1)!, data: { ...e, visits: sorted } };
      });
    },
    async pushed(sent) {
      const newest = Math.max(cell.get().historySince, ...sent.map((c) => c.updatedAt));
      cell.set({ ...cell.get(), historySince: newest });
    },
    async apply(items) {
      const visits = items
        .filter((i) => !i.deleted && isHistoryEntry(i.data) && /^https?:\/\//i.test((i.data as HistoryEntry).url))
        .flatMap((i) => {
          const e = i.data as HistoryEntry;
          return e.visits.map((time) => ({ url: e.url, title: e.title ?? "", time }));
        });
      if (visits.length) await domain.addHistory({ visits });
    },
  };
}

function shareable(windows: readonly OpenWindow[]): SyncedTabs {
  return {
    windows: windows
      .filter((w) => !w.incognito)
      .map((w) => ({
        tabs: w.tabs.filter((t) => /^https?:\/\//i.test(t.url)).map((t) => ({ url: t.url, title: t.title, pinned: t.pinned, ...(t.groupId ? { groupId: t.groupId } : {}) })),
        groups: w.groups,
      }))
      .filter((w) => w.tabs.length),
  };
}

const isSyncedTabs = (d: unknown): d is SyncedTabs => typeof d === "object" && d !== null && Array.isArray((d as SyncedTabs).windows);

export function tabsAdapter(domain: Domain, cell: StateCell, deviceId: string, now: () => number = Date.now): SyncAdapter {
  const id = `device:${deviceId}`;
  return {
    collection: "tabs",
    async changes() {
      const open = await domain.getOpenTabs();
      if (!open) return [];
      const data = shareable(open.windows);
      return hash(JSON.stringify(data)) === cell.get().tabs ? [] : [{ naturalId: id, updatedAt: now(), data }];
    },
    async pushed(sent) {
      const mine = sent.find((c) => c.naturalId === id);
      if (mine) cell.set({ ...cell.get(), tabs: hash(JSON.stringify(mine.data)) });
    },
    async apply(items: SyncedItem[]) {
      const remote = { ...cell.get().remoteTabs };
      for (const item of items) {
        const device = item.naturalId.startsWith("device:") ? item.naturalId.slice(7) : "";
        if (!device || device === deviceId) continue;
        if (item.deleted || !isSyncedTabs(item.data)) delete remote[device];
        else remote[device] = { ...item.data, updatedAt: item.updatedAt };
      }
      cell.set({ ...cell.get(), remoteTabs: remote });
    },
  };
}
