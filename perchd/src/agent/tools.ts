/** Runs the model's tool calls against the browser. Errors come back as text; nothing throws. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Browser } from "../browser/browser";
import { Tab } from "../browser/tab";
import type { ToolCall } from "../models/types";
import { back, click, describeRef, hover, press, scroll, select, type, upload, waitFor, type ActionResult } from "../page/actions";
import { refsFor } from "../page/refs";
import { repl } from "../page/repl";
import { clickAt, screenshot } from "../page/screenshot";
import { snapshot } from "../page/snapshot";
import type { PageContext, Target } from "./permissions";
import { TOOL_SPECS, validate } from "./tool-specs";

export { TOOL_SPECS };

export type ToolResult = { content: string; image?: string; isError?: boolean; done?: boolean };
export type ToolContext = {
  browser: Browser;
  tab: Tab | null;
  owned: Tab[];
  lastSnapshot: WeakMap<Tab, string>;
  shotScale: number;
  /** The chat's own folder: write_file saves here, and it is removed when the chat ends. */
  workDir: string;
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
    workDir: mkdtempSync(join(tmpdir(), "perch-chat-")),
    close: async () => {
      await Promise.all(ctx.owned.map((t) => t.close()));
      rmSync(ctx.workDir, { recursive: true, force: true });
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

/** Adds https:// to bare hosts; anything with another scheme is left for checkCall to refuse. */
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d+(\/|$)/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const WEB_URL = /^https?:\/\//i;
const REF = /^e\d{1,7}$/;

/**
 * Problems with a call that mean it must not run: schema errors, malformed refs, and URLs that
 * are not web pages. javascript: and data: run script with no approval, and file: reads local
 * files into the model's context, so the agent only opens http and https (and about:blank).
 */
export function checkCall(call: ToolCall): string | null {
  const problem = validate(call.name, call.args);
  if (problem) return problem;
  const ref = call.args.ref;
  if (typeof ref === "string" && !REF.test(ref)) return `ref "${ref}" is not a valid ref; refs look like e12`;
  if (call.name === "navigate" || call.name === "open_tab") {
    const url = normalizeUrl(String(call.args.url));
    if (url !== "about:blank" && !WEB_URL.test(url)) return "Perch's agent only opens http and https pages";
  }
  return null;
}

async function page(ctx: ToolContext, tab: Tab, full = false): Promise<string> {
  const snap = await snapshot(tab, { full });
  ctx.lastSnapshot.set(tab, snap.text);
  const [title, url] = await Promise.all([tab.title().catch(() => ""), tab.url().catch(() => "")]);
  return `Page: ${title} (${url})\n${snap.text}`;
}

async function withPage(ctx: ToolContext, tab: Tab, result: ActionResult): Promise<ToolResult> {
  if (!result.ok) return { content: [result.error, ...tab.takeDialogNotes()].join("\n"), isError: true };
  await tab.settle();
  const notes = tab.takeDialogNotes();
  return { content: `${[result.note, ...notes].join("\n")}\n\n${await page(ctx, tab)}` };
}

/** Role and name of the element a ref-based call targets, from the last snapshot of the tab. */
export function describeTarget(ctx: ToolContext, call: ToolCall): Target | undefined {
  const ref = call.args.ref;
  const text = ctx.tab ? ctx.lastSnapshot.get(ctx.tab) : undefined;
  if (typeof ref !== "string" || !text) return undefined;
  if (!REF.test(ref)) return undefined;
  const match = text.match(new RegExp(`- (\\S+) "((?:[^"\\\\]|\\\\.)*)" \\[ref=${ref}\\]`));
  return match ? { role: match[1]!, name: match[2]!.replace(/\\(.)/g, "$1") } : undefined;
}

/** The target of a ref the last snapshot did not show, read live from the page. */
export async function liveTarget(ctx: ToolContext, call: ToolCall): Promise<Target | undefined> {
  const ref = call.args.ref;
  if (!ctx.tab || typeof ref !== "string" || !REF.test(ref)) return undefined;
  return describeRef(ctx.tab, refsFor(ctx.tab), ref);
}

const PAGE_CONTEXT_JS = `(() => {
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const words = (el) => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, el.getAttribute('autocomplete')].join(' ');
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const card = inputs.some((el) => /(^|\\s)cc-/i.test(el.getAttribute('autocomplete') || '') || /card.?number|cardnumber|\\bcvc\\b|\\bcvv\\b|security code|expiration date/i.test(words(el)));
  const payFrame = [...document.querySelectorAll('iframe')].filter(visible).some((f) =>
    /js\\.stripe\\.com|braintree|adyen|paypal|squareup|klarna|affirm|checkout\\.com|payments?\\./i.test(f.src) || /payment|card number|secure (card|checkout)/i.test(f.title || ''));
  const checkoutUrl = /checkout|payment|\\/pay(\\/|$)|\\/order\\/(review|confirm)|\\/cart\\/confirm|\\/booking\\/(confirm|review|payment)/i.test(location.pathname);
  const passwords = inputs.filter((el) => el.type === 'password');
  const newPassword = passwords.some((el) => /new-password/i.test(el.getAttribute('autocomplete') || '')) ||
    (passwords.length >= 2 && passwords.some((el) => /new|confirm/i.test(words(el))));
  return { payment: card || payFrame || checkoutUrl, passwordChange: newPassword };
})()`;

/** Whether the current page is a checkout or a password change; both make more actions ask. */
export async function pageContext(ctx: ToolContext): Promise<PageContext> {
  if (!ctx.tab) return {};
  return ctx.tab.evaluate<PageContext>(PAGE_CONTEXT_JS).catch(() => ({}));
}

/** What an approval card shows besides the target: the text, files or form values that go out. */
export async function approvalDetail(ctx: ToolContext, call: ToolCall): Promise<string> {
  const a = call.args;
  if (call.name === "type") return `"${String(a.text)}"${a.submit ? " and press Enter" : ""}`;
  if (call.name === "upload") return (a.paths as string[]).join(", ");
  if (call.name === "select") return `"${String(a.value)}"`;
  if (call.name !== "click" || !ctx.tab || typeof a.ref !== "string" || !REF.test(a.ref)) return "";
  const fields = await ctx.tab
    .evaluate<string>(`(() => {
      const isSecret = (el) => el.type === 'password' || /(^|\\s)(cc-|one-time-code|current-password|new-password)/i.test(el.getAttribute('autocomplete') || '');
      const form = document.activeElement && document.activeElement.form || document.forms[0];
      if (!form) return '';
      return [...form.elements].filter((el) => el.name && el.type !== 'hidden' && el.type !== 'submit' && el.value)
        .slice(0, 8).map((el) => (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : el.name) + ': ' + (isSecret(el) ? '••••' : String(el.value).slice(0, 120))).join('; ');
    })()`)
    .catch(() => "");
  return fields ? `with ${fields}` : "";
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
  const problem = checkCall(call);
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
  if (call.name === "write_file") {
    // Only a plain file name: no folders, so nothing can be written outside the chat's folder.
    const name = basename(String(a.name)).replace(/[^\w.-]/g, "_").replace(/^\.+/, "") || "file.txt";
    const path = join(ctx.workDir, name);
    writeFileSync(path, String(a.content));
    return { content: `saved ${path} (${String(a.content).length} characters)` };
  }
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
    case "click_at": {
      const r = await clickAt(tab, a.x / ctx.shotScale, a.y / ctx.shotScale);
      return withPage(ctx, tab, r.ok ? { ok: true, note: `clicked at ${a.x}, ${a.y} in the screenshot` } : r);
    }
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
