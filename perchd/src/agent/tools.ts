/** Runs the model's tool calls against the browser. Errors come back as text; nothing throws. */

import type { Browser } from "../browser/browser";
import { Tab } from "../browser/tab";
import type { ToolCall } from "../models/types";
import { back, click, hover, press, scroll, select, type, upload, waitFor, type ActionResult } from "../page/actions";
import { refsFor } from "../page/refs";
import { repl } from "../page/repl";
import { clickAt, screenshot } from "../page/screenshot";
import { snapshot } from "../page/snapshot";
import type { Target } from "./permissions";
import { TOOL_SPECS, validate } from "./tool-specs";

export { TOOL_SPECS };

export type ToolResult = { content: string; image?: string; isError?: boolean; done?: boolean };
export type ToolContext = {
  browser: Browser;
  tab: Tab | null;
  owned: Tab[];
  lastSnapshot: WeakMap<Tab, string>;
  shotScale: number;
  close(): Promise<void>;
};

const SCREENSHOT_WIDTH = 1280;
const REPL_LIMIT = 20_000;

export async function newToolContext(browser: Browser): Promise<ToolContext> {
  const ctx: ToolContext = {
    browser,
    tab: null,
    owned: [],
    lastSnapshot: new WeakMap(),
    shotScale: 1,
    close: async () => {
      await Promise.all(ctx.owned.map((t) => t.close()));
    },
  };
  return ctx;
}

async function currentTab(ctx: ToolContext): Promise<Tab> {
  if (ctx.tab && !ctx.tab.closed) return ctx.tab;
  ctx.tab = await ctx.browser.newTab();
  ctx.owned.push(ctx.tab);
  return ctx.tab;
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(about|data|javascript):/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Waits briefly for the page to react, and for any navigation the action started. */
async function settle(tab: Tab): Promise<void> {
  await Bun.sleep(150);
  for (let i = 0; i < 50; i++) {
    const state = await tab.evaluate<string>("document.readyState").catch(() => "loading");
    if (state === "complete") return;
    await Bun.sleep(100);
  }
}

async function page(ctx: ToolContext, tab: Tab, full = false): Promise<string> {
  const snap = await snapshot(tab, { full });
  ctx.lastSnapshot.set(tab, snap.text);
  const [title, url] = await Promise.all([tab.title().catch(() => ""), tab.url().catch(() => "")]);
  return `Page: ${title} (${url})\n${snap.text}`;
}

async function withPage(ctx: ToolContext, tab: Tab, result: ActionResult): Promise<ToolResult> {
  if (!result.ok) return { content: result.error, isError: true };
  await settle(tab);
  return { content: `${result.note}\n\n${await page(ctx, tab)}` };
}

/** Role and name of the element a ref-based call targets, from the last snapshot of the tab. */
export function describeTarget(ctx: ToolContext, call: ToolCall): Target | undefined {
  const ref = call.args.ref;
  const text = ctx.tab ? ctx.lastSnapshot.get(ctx.tab) : undefined;
  if (typeof ref !== "string" || !text) return undefined;
  const match = text.match(new RegExp(`- (\\S+) "((?:[^"\\\\]|\\\\.)*)" \\[ref=${ref}\\]`));
  return match ? { role: match[1]!, name: match[2]!.replace(/\\(.)/g, "$1") } : undefined;
}

/** For a key press: the focused element, which is what the key acts on. */
export async function focusedTarget(ctx: ToolContext): Promise<Target | undefined> {
  if (!ctx.tab) return undefined;
  return ctx.tab
    .evaluate<Target | null>(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const t = (el.getAttribute('type') || '').toLowerCase();
      const role = el.getAttribute('role') || (el.tagName === 'SELECT' ? 'combobox' : t === 'search' ? 'searchbox' : /INPUT|TEXTAREA/.test(el.tagName) ? 'textbox' : el.tagName === 'BUTTON' ? 'button' : el.tagName.toLowerCase());
      const name = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || '';
      return { role, name: name.trim().slice(0, 80) };
    })()`)
    .then((t) => t ?? undefined)
    .catch(() => undefined);
}

export async function runTool(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  const problem = validate(call.name, call.args);
  if (problem) return { content: problem, isError: true };
  try {
    return await dispatch(ctx, call);
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

async function dispatch(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  const a = call.args as Record<string, any>;
  if (call.name === "done") return { content: String(a.answer), done: true };
  if (call.name === "tabs") return { content: await listTabs(ctx) };
  if (call.name === "switch_tab") return switchTab(ctx, String(a.id));
  if (call.name === "open_tab") {
    ctx.tab = await ctx.browser.newTab();
    ctx.owned.push(ctx.tab);
    await ctx.tab.navigate(normalizeUrl(a.url));
    return { content: `opened ${a.url} in a new tab\n\n${await page(ctx, ctx.tab)}` };
  }
  const tab = await currentTab(ctx);
  const refs = refsFor(tab);
  switch (call.name) {
    case "navigate":
      await tab.navigate(normalizeUrl(a.url));
      return { content: await page(ctx, tab) };
    case "snapshot":
      return { content: await page(ctx, tab, Boolean(a.full)) };
    case "click":
      return withPage(ctx, tab, await click(tab, refs, a.ref));
    case "type":
      return withPage(ctx, tab, await type(tab, refs, a.ref, a.text, { submit: Boolean(a.submit) }));
    case "select":
      return withPage(ctx, tab, await select(tab, refs, a.ref, a.value));
    case "press":
      return withPage(ctx, tab, await press(tab, a.key));
    case "scroll":
      return withPage(ctx, tab, await scroll(tab, { refs, ref: a.ref, dy: a.dy }));
    case "hover":
      return withPage(ctx, tab, await hover(tab, refs, a.ref));
    case "upload":
      return withPage(ctx, tab, await upload(tab, refs, a.ref, a.paths));
    case "back":
      return withPage(ctx, tab, await back(tab));
    case "wait_for": {
      const r = await waitFor(tab, { text: a.text, timeoutMs: Math.min(60, Number(a.timeout_s ?? 10)) * 1000 });
      return r.ok ? { content: r.note } : { content: r.error, isError: true };
    }
    case "screenshot": {
      const shot = await screenshot(tab, { maxWidth: SCREENSHOT_WIDTH });
      const [width] = await tab.evaluate<[number]>("[innerWidth]");
      ctx.shotScale = shot.width / width;
      return { content: `screenshot ${shot.width}×${shot.height}`, image: shot.jpegBase64 };
    }
    case "click_at":
      return withPage(ctx, tab, await clickAt(tab, a.x / ctx.shotScale, a.y / ctx.shotScale));
    case "repl": {
      const r = await repl(tab, a.code);
      if (r.error) return { content: r.error, isError: true };
      const json = JSON.stringify(r.result) ?? "undefined";
      return { content: json.length > REPL_LIMIT ? `${json.slice(0, REPL_LIMIT)}… (${json.length.toLocaleString("en-US")} characters, cut)` : json };
    }
  }
  return { content: `unknown tool "${call.name}"`, isError: true };
}

async function listTabs(ctx: ToolContext): Promise<string> {
  const tabs = await ctx.browser.tabs();
  return tabs.map((t) => `${t.id === ctx.tab?.id ? "* " : "  "}${t.id} ${t.title || "(untitled)"} · ${t.url}`).join("\n");
}

async function switchTab(ctx: ToolContext, id: string): Promise<ToolResult> {
  const known = ctx.owned.find((t) => t.id === id && !t.closed);
  const tabs = await ctx.browser.tabs();
  if (!known && !tabs.some((t) => t.id === id)) return { content: `no tab with id ${id}; call tabs to list them`, isError: true };
  ctx.tab = known ?? (await Tab.attach(ctx.browser.conn, id));
  return { content: `switched tabs\n\n${await page(ctx, ctx.tab)}` };
}
