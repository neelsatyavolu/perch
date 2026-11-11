/**
 * `perch repl`: a persistent JavaScript session over the browser, in the shape of Aside's REPL.
 * It keeps a QuickJS context per agent session (script.ts), so top-level `const`s, `let`s,
 * functions and classes stay from one run to the next, and adds a Playwright-style `page` with
 * `openTab`, `listBrowserTabs`, `attachBrowserTab` and `snapshot(page)` returning `{ tree, diff }`.
 * Every action is one of Perch's tools, checked, approved and audited as usual.
 */

import { LIMITS, ScriptVm, type ScriptLimits } from "./script";
import type { ToolCall } from "../models/types";
import type { ToolResult } from "./tools";

/** The REPL's own globals, written in the sandbox on top of the script functions. */
const REPL_PRELUDE = String.raw`
let __current = null;
const __pages = new Map();
const __snaps = new Map();
globalThis.page = undefined;

const __json = (text) => { try { return JSON.parse(text); } catch { return text; } };

/** Parses the tabs tool's lines: "* <id> <title> · <url> (yours)". */
async function listBrowserTabs() {
  const text = await __tool("tabs", {});
  return text.split("\n").map((line) => /^(\*)?\s*([0-9A-Fa-f]{16,})\s+(.*) · (\S+)(?:\s+\(([^)]*)\))?\s*$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ targetId: m[2], title: m[3], url: m[4], owner: m[5] ?? "", current: m[1] === "*" }));
}

function __page(id) {
  if (__pages.has(id)) return __pages.get(id);
  const focus = async () => {
    if (__current !== id) {
      await __tool("switch_tab", { id });
      __current = id;
    }
  };
  const act = (name, args) => async () => (await focus(), __tool(name, args));
  const locator = (ref) => {
    if (!/^(?:f\d+)?e\d+$/.test(String(ref))) throw new Error("locator() takes a ref from snapshot(), like e12");
    return {
      click: () => act("click", { ref })(),
      fill: (text) => act("type", { ref, text: String(text) })(),
      type: (text) => act("type", { ref, text: String(text) })(),
      press: async (key) => (await act("click", { ref })(), __tool("press", { key })),
      selectOption: (value) => act("select", { ref, value: String(value) })(),
      hover: () => act("hover", { ref })(),
      scrollIntoViewIfNeeded: () => act("scroll", { ref })(),
      check: () => act("click", { ref })(),
    };
  };
  const p = {
    targetId: id,
    goto: async (url) => (await focus(), __tool("navigate", { url: String(url) }), null),
    goBack: async () => (await focus(), __tool("back", {}), null),
    reload: async () => (await focus(), __tool("navigate", { url: await p.url() }), null),
    url: async () => (await focus(), __json(await __tool("repl", { code: "return location.href" }))),
    title: async () => (await focus(), __json(await __tool("repl", { code: "return document.title" }))),
    content: async () => (await focus(), __json(await __tool("repl", { code: "return document.documentElement.outerHTML" }))),
    evaluate: async (fn, arg) => {
      await focus();
      const code = typeof fn === "function" ? "return (" + fn.toString() + ")(" + JSON.stringify(arg ?? null) + ")" : /\breturn\b/.test(String(fn)) ? String(fn) : "return (" + String(fn) + ")";
      return __json(await __tool("repl", { code }));
    },
    locator,
    keyboard: {
      press: async (key) => (await focus(), __tool("press", { key: String(key) })),
      type: async (text) => (await focus(), __tool("type_text", { text: String(text) })),
    },
    mouse: { wheel: async (_dx, dy) => (await focus(), __tool("scroll", { dy: Number(dy) || 0 })) },
    waitForTimeout: (ms) => sleep((Number(ms) || 0) / 1000),
    waitForText: async (text, seconds) => (await focus(), __tool("wait_for", { text: String(text), ...(seconds ? { timeout_s: seconds } : {}) })),
    screenshot: async () => { throw new Error("Screenshots are not available in the REPL; run perch screenshot -o file.jpg"); },
    close: async () => { throw new Error("Perch closes your tabs when the session ends: perch session end"); },
  };
  __pages.set(id, p);
  return p;
}

/** Reads the page as text; diff lists lines added (+) and gone (-) since the last snapshot of this tab. */
globalThis.snapshot = async function snapshot(p = globalThis.page, options = {}) {
  if (!p || !p.targetId) throw new Error("No page yet: openTab(url) or attachBrowserTab(id) first");
  if (__current !== p.targetId) {
    await __tool("switch_tab", { id: p.targetId });
    __current = p.targetId;
  }
  const tree = await __tool("snapshot", { full: Boolean(options.full) });
  const before = __snaps.get(p.targetId);
  __snaps.set(p.targetId, tree);
  let diff = "";
  if (before === undefined) diff = "(first snapshot of this tab)";
  else if (before === tree) diff = "(no change)";
  else {
    const old = new Set(before.split("\n"));
    const now = new Set(tree.split("\n"));
    diff = [...tree.split("\n").filter((l) => !old.has(l)).map((l) => "+ " + l), ...before.split("\n").filter((l) => !now.has(l)).map((l) => "- " + l)].join("\n");
  }
  return { tree, diff, toString: () => tree };
};

globalThis.tabs = [];

async function openTab(url) {
  await __tool("open_tab", { url: String(url) });
  const current = (await listBrowserTabs()).find((t) => t.current);
  if (!current) throw new Error("The new tab did not open");
  __current = current.targetId;
  const p = __page(current.targetId);
  if (!globalThis.tabs.includes(p)) globalThis.tabs = [...globalThis.tabs, p];
  globalThis.page = p;
  return p;
}

async function attachBrowserTab(targetId) {
  await __tool("switch_tab", { id: String(targetId) });
  __current = String(targetId);
  const p = __page(String(targetId));
  if (!globalThis.tabs.includes(p)) globalThis.tabs = [...globalThis.tabs, p];
  globalThis.page = p;
  return p;
}

const getTabByTargetId = (id) => __pages.get(String(id));
async function closeTab() { throw new Error("Perch closes your tabs when the session ends: perch session end"); }
`;

/** How long an unused REPL keeps its variables. */
const IDLE_MS = 30 * 60_000;
/** A REPL run may do more than one script tool call. */
export const REPL_LIMITS: ScriptLimits = { ...LIMITS, calls: 100, memory: 64 * 1024 * 1024 };

type Entry = { vm: Promise<ScriptVm>; timer: ReturnType<typeof setTimeout>; runs: Promise<unknown> };

/** One REPL per agent session, freed after half an hour unused or when the session ends. */
export class ReplSessions {
  private readonly repls = new Map<string, Entry>();
  private n = 0;

  constructor(private readonly idleMs = IDLE_MS) {}

  /** Runs `code` in the session's REPL; runs of one session wait for each other. */
  run(key: string, code: string, call: (c: ToolCall) => Promise<ToolResult>): Promise<ToolResult> {
    const entry = this.repls.get(key) ?? this.open(key);
    clearTimeout(entry.timer);
    entry.timer = this.expire(key);
    const id = `repl.${++this.n}`;
    const result = entry.runs.then(async () => (await entry.vm).run(code, call, id, true));
    entry.runs = result.catch(() => undefined);
    return result;
  }

  reset(key: string): boolean {
    const entry = this.repls.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.repls.delete(key);
    void entry.vm.then((vm) => vm.dispose(), () => undefined);
    return true;
  }

  close(): void {
    for (const key of [...this.repls.keys()]) this.reset(key);
  }

  private open(key: string): Entry {
    const entry: Entry = { vm: ScriptVm.create(REPL_LIMITS, REPL_PRELUDE), timer: this.expire(key), runs: Promise.resolve() };
    this.repls.set(key, entry);
    return entry;
  }

  private expire(key: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => this.reset(key), this.idleMs);
    t.unref?.();
    return t;
  }
}
