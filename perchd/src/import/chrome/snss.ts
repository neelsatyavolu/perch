/**
 * Chromium's session files (`Sessions/Session_<time>`, SNSS format): the open windows and tabs.
 *
 * The file is "SNSS", an int32 version, then commands: uint16 size, uint8 id, payload. Some
 * payloads are plain C structs, others are base::Pickle (uint32 length, then 4-byte aligned
 * fields). Replaying the commands in order rebuilds the last state, as Chromium's
 * RestoreSessionFromCommands does. Only what an import needs is replayed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { permissionError } from "../sqlite-copy";
import type { SessionTab, SessionWindow, TabGroup } from "../types";

export const CMD = {
  setTabWindow: 0,
  setTabIndexInWindow: 2,
  prunedFromBack: 5,
  updateTabNavigation: 6,
  setSelectedNavigationIndex: 7,
  setSelectedTabInIndex: 8,
  setWindowType: 9,
  prunedFromFront: 11,
  setPinnedState: 12,
  tabClosed: 16,
  windowClosed: 17,
  pruned: 24,
  setTabGroup: 25,
  setTabGroupMetadata2: 27,
} as const;

export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;

class Pickle {
  private pos = 4;
  private readonly end: number;
  constructor(private readonly buf: Buffer) {
    this.end = Math.min(buf.length, 4 + buf.readUInt32LE(0));
  }
  private take(n: number): number {
    const at = this.pos;
    if (at + n > this.end) throw new RangeError("pickle overrun");
    this.pos += (n + 3) & ~3;
    return at;
  }
  int(): number {
    return this.buf.readInt32LE(this.take(4));
  }
  uint64(): bigint {
    return this.buf.readBigUInt64LE(this.take(8));
  }
  string(): string {
    const len = this.int();
    const at = this.take(len);
    return this.buf.toString("utf8", at, at + len);
  }
  string16(): string {
    const len = this.int();
    const at = this.take(len * 2);
    return this.buf.toString("utf16le", at, at + len * 2);
  }
}

type Nav = { url: string; title: string };
type Tab = { window?: number; index: number; navs: Map<number, Nav>; current: number; pinned: boolean; group?: string };
type Win = { selected: number; type: number };

const tokenId = (high: bigint, low: bigint) => `${high.toString(16).padStart(16, "0")}${low.toString(16).padStart(16, "0")}`;

export function parseSnss(buf: Buffer): SessionWindow[] | undefined {
  if (buf.length < 8 || buf.toString("latin1", 0, 4) !== "SNSS") return undefined;
  const version = buf.readInt32LE(4);
  if (version !== 1 && version !== 3) return undefined; // 2 and 4 are encrypted session files.
  const tabs = new Map<number, Tab>();
  const windows = new Map<number, Win>();
  const groups = new Map<string, TabGroup>();
  const tab = (id: number): Tab => {
    const t = tabs.get(id) ?? { index: 0, navs: new Map(), current: -1, pinned: false };
    tabs.set(id, t);
    return t;
  };
  const win = (id: number): Win => {
    const w = windows.get(id) ?? { selected: 0, type: 0 };
    windows.set(id, w);
    return w;
  };
  let pos = 8;
  while (pos + 3 <= buf.length) {
    const size = buf.readUInt16LE(pos);
    if (size < 1 || pos + 2 + size > buf.length) break;
    const id = buf[pos + 2]!;
    const p = buf.subarray(pos + 3, pos + 2 + size);
    pos += 2 + size;
    try {
      apply(id, p, { tab, win, tabs, windows, groups });
    } catch {
      // A damaged command is skipped, as Chromium does.
    }
  }
  return build(tabs, windows, groups);
}

type State = { tab: (id: number) => Tab; win: (id: number) => Win; tabs: Map<number, Tab>; windows: Map<number, Win>; groups: Map<string, TabGroup> };

function apply(id: number, p: Buffer, s: State): void {
  const i32 = (at: number) => p.readInt32LE(at);
  switch (id) {
    case CMD.setTabWindow:
      s.tab(i32(4)).window = i32(0);
      s.win(i32(0));
      return;
    case CMD.setTabIndexInWindow:
      s.tab(i32(0)).index = i32(4);
      return;
    case CMD.updateTabNavigation: {
      const k = new Pickle(p);
      const t = s.tab(k.int());
      const index = k.int();
      const url = k.string();
      t.navs.set(index, { url, title: k.string16() });
      return;
    }
    case CMD.setSelectedNavigationIndex:
      s.tab(i32(0)).current = i32(4);
      return;
    case CMD.setSelectedTabInIndex:
      s.win(i32(0)).selected = i32(4);
      return;
    case CMD.setWindowType:
      s.win(i32(0)).type = i32(4);
      return;
    case CMD.setPinnedState:
      s.tab(i32(0)).pinned = p[4] !== 0;
      return;
    case CMD.tabClosed:
      s.tabs.delete(i32(0));
      return;
    case CMD.windowClosed:
      s.windows.delete(i32(0));
      return;
    case CMD.prunedFromBack:
      prune(s.tab(i32(0)), i32(4), Infinity);
      return;
    case CMD.prunedFromFront:
      prune(s.tab(i32(0)), 0, i32(4));
      return;
    case CMD.pruned:
      prune(s.tab(i32(0)), i32(4), i32(8));
      return;
    case CMD.setTabGroup: {
      const t = s.tab(i32(0));
      t.group = p[24] ? tokenId(p.readBigUInt64LE(8), p.readBigUInt64LE(16)) : undefined;
      return;
    }
    case CMD.setTabGroupMetadata2: {
      const k = new Pickle(p);
      const gid = tokenId(k.uint64(), k.uint64());
      const title = k.string16();
      const color = GROUP_COLORS[k.int()] ?? "grey";
      let collapsed = false;
      try {
        collapsed = k.int() !== 0;
      } catch {
        // Older files end after the colour.
      }
      s.groups.set(gid, { id: gid, title, color, collapsed });
      return;
    }
  }
}

/** Remove `count` navigations starting at `from` and shift later ones down. */
function prune(t: Tab, from: number, count: number): void {
  const kept = new Map<number, Nav>();
  for (const [i, nav] of t.navs) {
    if (i < from) kept.set(i, nav);
    else if (i >= from + count) kept.set(i - count, nav);
  }
  t.navs = kept;
  if (t.current >= from + count) t.current -= count;
  else if (t.current >= from) t.current = Math.max(from - 1, kept.size > 0 ? Math.min(from, kept.size - 1) : -1);
}

function build(tabs: Map<number, Tab>, windows: Map<number, Win>, groups: Map<string, TabGroup>): SessionWindow[] {
  return [...windows.entries()]
    .filter(([, w]) => w.type === 0)
    .flatMap(([wid, w]): SessionWindow[] => {
      const own = [...tabs.values()].filter((t) => t.window === wid && t.navs.size > 0).sort((a, b) => a.index - b.index);
      const out: SessionTab[] = own.flatMap((t) => {
        const nav = t.navs.get(t.current) ?? t.navs.get(Math.max(...t.navs.keys()));
        if (!nav || !nav.url) return [];
        return [{ url: nav.url, title: nav.title, pinned: t.pinned, ...(t.group && groups.has(t.group) ? { groupId: t.group } : {}) }];
      });
      if (out.length === 0) return [];
      const used = new Set(out.map((t) => t.groupId).filter(Boolean));
      const selectedTab = own.findIndex((t) => t.index === w.selected);
      return [{ tabs: out, selected: Math.max(0, Math.min(selectedTab === -1 ? w.selected : selectedTab, out.length - 1)), groups: [...groups.values()].filter((g) => used.has(g.id)) }];
    });
}

/** The newest session file in a profile: Sessions/Session_<n>, or the older "Current Session". */
export function readChromeSession(profile: string): SessionWindow[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(profile, "Sessions")).filter((n) => /^Session_\d+$/.test(n));
  } catch {
    // No Sessions folder: older layout below.
  }
  const newest = [...names].sort((a, b) => Number(BigInt(b.slice(8)) - BigInt(a.slice(8))))[0];
  const candidates = [...(newest ? [join(profile, "Sessions", newest)] : []), join(profile, "Current Session"), join(profile, "Last Session")];
  for (const path of candidates) {
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch (error) {
      const denied = permissionError(error, path);
      if (denied) throw denied;
      continue;
    }
    const parsed = parseSnss(buf);
    if (parsed) return parsed;
  }
  return [];
}
