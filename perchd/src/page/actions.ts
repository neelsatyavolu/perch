/** Things the agent can do to a page. Every action reports success or a plain error; none throws. */

import { existsSync } from "node:fs";
import type { Tab } from "../browser/tab";
import { parseKey } from "./keys";
import { RefGone, type RefTable, type RefTarget } from "./refs";

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

/** A live node: its ids, its session (for cross-site iframes) and the iframe that owns it. */
type Node = RefTarget & { objectId: string };

/** The live DOM object behind a ref, or RefGone if the page removed it. */
async function liveNode(tab: Tab, refs: RefTable, ref: string): Promise<Node> {
  const target = refs.resolve(ref);
  let objectId: string | undefined;
  try {
    ({ object: { objectId } } = await tab.sendIn<{ object: { objectId?: string } }>(target.session, "DOM.resolveNode", { backendNodeId: target.backendNodeId }));
  } catch {
    throw new RefGone(ref);
  }
  if (!objectId) throw new RefGone(ref);
  const node: Node = { ...target, objectId };
  const connected = await call<boolean>(tab, node, "function () { return this.isConnected; }");
  if (!connected) throw new RefGone(ref);
  return node;
}

async function call<T>(tab: Tab, node: { objectId: string; session?: string }, fn: string, args: unknown[] = []): Promise<T> {
  const res = await tab.sendIn<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
    node.session,
    "Runtime.callFunctionOn",
    { objectId: node.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
  );
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value as T;
}

/**
 * Role and name of an element, for notes, approvals and "covered by" errors. Field values are
 * never used as names (they may be secrets), except the label of an input button.
 */
const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const owner = (el && el.closest('[role],dialog,button,a,input,select,textarea,label,h1,h2,h3')) || el;
  if (!owner) return { role: 'element', name: '' };
  const tag = owner.tagName;
  const type = (owner.getAttribute('type') || '').toLowerCase();
  const role = owner.getAttribute('role') || ({ A: 'link', DIALOG: 'dialog', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', BUTTON: 'button', LABEL: 'label' })[tag]
    || (tag === 'INPUT' ? (['button', 'submit', 'reset'].includes(type) ? 'button' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'search' ? 'searchbox' : 'textbox') : tag.toLowerCase());
  const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const label = owner.getAttribute('aria-label') || (owner.labels && owner.labels[0] && owner.labels[0].innerText) || owner.getAttribute('placeholder') || owner.getAttribute('title') || '';
  const text = isField ? (['button', 'submit', 'reset'].includes(type) ? owner.value : '') : owner.innerText;
  return { role, name: (label || text || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
}`;

type Described = { role: string; name: string };
const show = (d: Described) => (d.name ? `${d.role} "${d.name}"` : d.role);

/** Role and name of the element behind a ref, read live from the page. */
export async function describeRef(tab: Tab, refs: RefTable, ref: string): Promise<Described | undefined> {
  try {
    const node = await liveNode(tab, refs, ref);
    return await call<Described>(tab, node, DESCRIBE);
  } catch {
    return undefined;
  }
}

/** Top-left of a cross-site iframe's content box in page coordinates. */
async function frameOffset(tab: Tab, owner: number | undefined): Promise<{ x: number; y: number }> {
  if (owner === undefined) return { x: 0, y: 0 };
  const { quads } = await tab.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: owner });
  const q = quads[0];
  return q ? { x: Math.min(q[0]!, q[6]!), y: Math.min(q[1]!, q[3]!) } : { x: 0, y: 0 };
}

/** The centre of an element's first visible box, in page coordinates, after scrolling it into view. */
async function centre(tab: Tab, node: Node): Promise<{ x: number; y: number }> {
  if (node.owner !== undefined) await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.owner }).catch(() => undefined);
  await tab.sendIn(node.session, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }).catch(() => undefined);
  const { quads } = await tab.sendIn<{ quads: number[][] }>(node.session, "DOM.getContentQuads", { backendNodeId: node.backendNodeId });
  const quad = quads.find((q) => Math.abs((q[4]! - q[0]!) * (q[5]! - q[1]!)) > 1);
  if (!quad) throw new Error("the element is not visible");
  const offset = await frameOffset(tab, node.owner);
  return { x: offset.x + (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: offset.y + (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
}

/** Fails with "covered by …" when another element would receive a click at the point. */
async function assertHittable(tab: Tab, target: Node, point: { x: number; y: number }): Promise<void> {
  // Inside a cross-site iframe, hit-test in the frame's own coordinates and session.
  const offset = await frameOffset(tab, target.owner);
  const local = { x: Math.round(point.x - offset.x), y: Math.round(point.y - offset.y) };
  const hit = await tab.sendIn<{ backendNodeId: number }>(target.session, "DOM.getNodeForLocation", { ...local, includeUserAgentShadowDOM: true });
  const { object } = await tab.sendIn<{ object: { objectId?: string } }>(target.session, "DOM.resolveNode", { backendNodeId: hit.backendNodeId });
  if (!object.objectId) return;
  const inside = await tab.sendIn<{ result: { value?: boolean } }>(target.session, "Runtime.callFunctionOn", {
    objectId: target.objectId,
    // The hit counts if it is the target, inside it, or inside a label for it (custom checkboxes).
    functionDeclaration:
      "function (other) { for (let n = other; n; n = n.parentNode || n.host) { if (n === this) return true; if (n.tagName === 'LABEL' && n.control === this) return true; } return false; }",
    arguments: [{ objectId: object.objectId }],
    returnByValue: true,
  });
  if (inside.result.value) return;
  throw new Error(`covered by ${show(await call<Described>(tab, { objectId: object.objectId, session: target.session }, DESCRIBE))}`);
}

async function mouse(tab: Tab, type: string, point: { x: number; y: number }, extra: object = {}): Promise<void> {
  await tab.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra });
}

export function click(tab: Tab, refs: RefTable, ref: string): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    const point = await centre(tab, node);
    await assertHittable(tab, node, point);
    const label = show(await call<Described>(tab, node, DESCRIBE));
    await mouse(tab, "mouseMoved", point);
    await mouse(tab, "mousePressed", point, { button: "left", buttons: 1, clickCount: 1 });
    await mouse(tab, "mouseReleased", point, { button: "left", buttons: 0, clickCount: 1 });
    return ok(`clicked ${label}`);
  });
}

export function hover(tab: Tab, refs: RefTable, ref: string): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    await mouse(tab, "mouseMoved", await centre(tab, node));
    return ok(`hovered ${show(await call<Described>(tab, node, DESCRIBE))}`);
  });
}

/** Replaces the field's contents with text, as a person selecting all and typing would. */
export function type(tab: Tab, refs: RefTable, ref: string, text: string, opts: { submit?: boolean } = {}): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    const special = await setSpecialInput(tab, node, text);
    if (special) return special;
    if (node.owner !== undefined) await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.owner }).catch(() => undefined);
    await tab.sendIn(node.session, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }).catch(() => undefined);
    await tab.sendIn(node.session, "DOM.focus", { backendNodeId: node.backendNodeId });
    await call(tab, node, "function () { if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) document.execCommand('selectAll'); }");
    if (text) await tab.send("Input.insertText", { text });
    else await press(tab, "Delete");
    if (opts.submit) await press(tab, "Enter");
    return ok(`typed ${text.length} characters${opts.submit ? " and pressed Enter" : ""}`);
  });
}

const FORMATS: Record<string, [string, string]> = {
  date: ["YYYY-MM-DD", "2026-11-05"],
  time: ["HH:MM", "14:30"],
  "datetime-local": ["YYYY-MM-DDTHH:MM", "2026-11-05T14:30"],
  month: ["YYYY-MM", "2026-11"],
  week: ["YYYY-Www", "2026-W45"],
  color: ["#RRGGBB", "#4c8dff"],
};

/**
 * Date, time, month, week and colour inputs ignore typed text in Chromium, so their value is set
 * the way the browser's picker sets it: through the value setter, then input and change events.
 */
async function setSpecialInput(tab: Tab, node: Node, text: string): Promise<ActionResult | null> {
  const kind = await call<string>(tab, node, "function () { return this.tagName === 'INPUT' ? (this.getAttribute('type') || '').toLowerCase() : ''; }");
  const format = FORMATS[kind];
  if (!format) return null;
  const applied = await call<string>(
    tab,
    node,
    `function (v) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(this, v);
      if (this.value !== v && !(this.type === 'color' && this.value === v.toLowerCase())) return this.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return this.value;
    }`,
    [text],
  );
  if (applied.toLowerCase() !== text.toLowerCase()) return fail(`this is a ${kind === "datetime-local" ? "date and time" : kind} field; give the value as ${format[0]}, for example ${format[1]}`);
  return ok(`set the ${kind} to ${applied}`);
}

export function select(tab: Tab, refs: RefTable, ref: string, choice: string): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    const result = await call<{ chosen?: string; options?: string[] }>(
      tab,
      node,
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
    const { def, modifiers, commands } = parsed;
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
    await tab.send("Input.dispatchKeyEvent", { type: def.text ? "keyDown" : "rawKeyDown", ...base, text: def.text, ...(commands ? { commands } : {}) });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return ok(`pressed ${combo}`);
  });
}

export function scroll(tab: Tab, opts: { refs?: RefTable; ref?: string; dy?: number }): Promise<ActionResult> {
  return attempt(async () => {
    if (opts.ref && opts.refs) {
      const node = await liveNode(tab, opts.refs, opts.ref);
      if (node.owner !== undefined) await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.owner }).catch(() => undefined);
      await tab.sendIn(node.session, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
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
    await tab.sendIn(node.session, "DOM.setFileInputFiles", { files: paths, backendNodeId: node.backendNodeId });
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
