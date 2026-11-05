/** Things the agent can do to a page. Every action reports success or a plain error; none throws. */

import { existsSync } from "node:fs";
import type { Tab } from "../browser/tab";
import { parseKey } from "./keys";
import { RefGone, type RefTable } from "./refs";

export type ActionResult = { ok: true; note: string } | { ok: false; error: string };

const ok = (note: string): ActionResult => ({ ok: true, note });
const fail = (error: string): ActionResult => ({ ok: false, error });

async function attempt(work: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await work();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** The live DOM object behind a ref, or RefGone if the page removed it. */
async function liveNode(tab: Tab, refs: RefTable, ref: string): Promise<{ backendNodeId: number; objectId: string }> {
  const { backendNodeId } = refs.resolve(ref);
  let objectId: string | undefined;
  try {
    ({ object: { objectId } } = await tab.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId }));
  } catch {
    throw new RefGone(ref);
  }
  if (!objectId) throw new RefGone(ref);
  const connected = await call<boolean>(tab, objectId, "function () { return this.isConnected; }");
  if (!connected) throw new RefGone(ref);
  return { backendNodeId, objectId };
}

async function call<T>(tab: Tab, objectId: string, fn: string, args: unknown[] = []): Promise<T> {
  const res = await tab.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
  );
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value as T;
}

const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const owner = el && el.closest('[role],dialog,button,a,input,select,textarea,label,h1,h2,h3') || el;
  if (!owner) return 'something';
  const role = owner.getAttribute('role') || ({ A: 'link', DIALOG: 'dialog', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading' })[owner.tagName] || owner.tagName.toLowerCase();
  const name = (owner.getAttribute('aria-label') || owner.innerText || owner.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  return name ? role + ' "' + name + '"' : role;
}`;

/** The centre of an element's first visible box, after scrolling it into view. */
async function centre(tab: Tab, backendNodeId: number): Promise<{ x: number; y: number }> {
  await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
  const { quads } = await tab.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId });
  const quad = quads.find((q) => Math.abs((q[4]! - q[0]!) * (q[5]! - q[1]!)) > 1);
  if (!quad) throw new Error("the element is not visible");
  return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
}

/** Fails with "covered by …" when another element would receive a click at the point. */
async function assertHittable(tab: Tab, target: { objectId: string }, point: { x: number; y: number }): Promise<void> {
  const hit = await tab.send<{ backendNodeId: number }>("DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true });
  const { object } = await tab.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: hit.backendNodeId });
  if (!object.objectId) return;
  const inside = await tab.send<{ result: { value?: boolean } }>("Runtime.callFunctionOn", {
    objectId: target.objectId,
    functionDeclaration: "function (other) { for (let n = other; n; n = n.parentNode || n.host) { if (n === this) return true; } return false; }",
    arguments: [{ objectId: object.objectId }],
    returnByValue: true,
  });
  if (inside.result.value) return;
  throw new Error(`covered by ${await call<string>(tab, object.objectId, DESCRIBE)}`);
}

async function mouse(tab: Tab, type: string, point: { x: number; y: number }, extra: object = {}): Promise<void> {
  await tab.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra });
}

export function click(tab: Tab, refs: RefTable, ref: string): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    const point = await centre(tab, node.backendNodeId);
    await assertHittable(tab, node, point);
    const label = await call<string>(tab, node.objectId, DESCRIBE);
    await mouse(tab, "mouseMoved", point);
    await mouse(tab, "mousePressed", point, { button: "left", buttons: 1, clickCount: 1 });
    await mouse(tab, "mouseReleased", point, { button: "left", buttons: 0, clickCount: 1 });
    return ok(`clicked ${label}`);
  });
}

export function hover(tab: Tab, refs: RefTable, ref: string): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    await mouse(tab, "mouseMoved", await centre(tab, node.backendNodeId));
    return ok(`hovered ${await call<string>(tab, node.objectId, DESCRIBE)}`);
  });
}

/** Replaces the field's contents with text, as a person selecting all and typing would. */
export function type(tab: Tab, refs: RefTable, ref: string, text: string, opts: { submit?: boolean } = {}): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }).catch(() => undefined);
    await tab.send("DOM.focus", { backendNodeId: node.backendNodeId });
    await call(tab, node.objectId, "function () { if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) document.execCommand('selectAll'); }");
    if (text) await tab.send("Input.insertText", { text });
    else await press(tab, "Delete");
    if (opts.submit) await press(tab, "Enter");
    return ok(`typed ${text.length} characters${opts.submit ? " and pressed Enter" : ""}`);
  });
}

export function select(tab: Tab, refs: RefTable, ref: string, choice: string): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    const result = await call<{ chosen?: string; options?: string[] }>(
      tab,
      node.objectId,
      `function (choice) {
        const opts = Array.from(this.options || []);
        const want = choice.trim().toLowerCase();
        const hit = opts.find(o => o.label.trim().toLowerCase() === want) || opts.find(o => o.value.toLowerCase() === want);
        if (!hit) return { options: opts.map(o => o.label.trim()) };
        this.value = hit.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { chosen: hit.label.trim() };
      }`,
      [choice],
    );
    if (result.chosen === undefined) return fail(`no option "${choice}"; options are: ${(result.options ?? []).join(", ")}`);
    return ok(`selected "${result.chosen}"`);
  });
}

export function press(tab: Tab, combo: string): Promise<ActionResult> {
  return attempt(async () => {
    const parsed = parseKey(combo);
    if (!parsed) return fail(`unknown key "${combo}"`);
    const { def, modifiers } = parsed;
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
    await tab.send("Input.dispatchKeyEvent", { type: def.text ? "keyDown" : "rawKeyDown", ...base, text: def.text });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return ok(`pressed ${combo}`);
  });
}

export function scroll(tab: Tab, opts: { refs?: RefTable; ref?: string; dy?: number }): Promise<ActionResult> {
  return attempt(async () => {
    if (opts.ref && opts.refs) {
      const node = await liveNode(tab, opts.refs, opts.ref);
      await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
      return ok(`scrolled ${opts.ref} into view`);
    }
    const [w, h] = await tab.evaluate<[number, number]>("[innerWidth, innerHeight]");
    const dy = opts.dy ?? h * 0.8;
    const before = await tab.evaluate<number>("scrollY");
    await mouse(tab, "mouseWheel", { x: w / 2, y: h / 2 }, { deltaX: 0, deltaY: dy });
    for (let i = 0; i < 20 && (await tab.evaluate<number>("scrollY")) === before; i++) await Bun.sleep(25);
    return ok(`scrolled to ${Math.round(await tab.evaluate<number>("scrollY"))}px`);
  });
}

export function upload(tab: Tab, refs: RefTable, ref: string, paths: string[]): Promise<ActionResult> {
  return attempt(async () => {
    const missing = paths.filter((p) => !existsSync(p));
    if (missing.length) return fail(`file not found: ${missing.join(", ")}`);
    const node = await liveNode(tab, refs, ref);
    await tab.send("DOM.setFileInputFiles", { files: paths, backendNodeId: node.backendNodeId });
    return ok(`attached ${paths.length} file${paths.length === 1 ? "" : "s"}`);
  });
}

export function waitFor(tab: Tab, opts: { text?: string; timeoutMs?: number }): Promise<ActionResult> {
  return attempt(async () => {
    const timeout = opts.timeoutMs ?? 10_000;
    const text = opts.text ?? "";
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await tab.evaluate<boolean>(`document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`)) return ok(`"${text}" is on the page`);
      await Bun.sleep(100);
    }
    return fail(`waited ${timeout / 1000}s; "${text}" did not appear`);
  });
}

export function back(tab: Tab): Promise<ActionResult> {
  return attempt(async () => {
    const history = await tab.send<{ currentIndex: number; entries: { id: number; url: string }[] }>("Page.getNavigationHistory");
    const previous = history.entries[history.currentIndex - 1];
    if (!previous) return fail("there is no earlier page in this tab");
    await tab.send("Page.navigateToHistoryEntry", { entryId: previous.id });
    for (let i = 0; i < 100 && (await tab.url().catch(() => "")) !== previous.url; i++) await Bun.sleep(25);
    for (let i = 0; i < 100 && (await tab.evaluate<string>("document.readyState").catch(() => "")) !== "complete"; i++) await Bun.sleep(25);
    return ok(`went back to ${previous.url}`);
  });
}
