/** Things the agent can do to a page. Every action reports success or a plain error; none throws. */

import { existsSync } from "node:fs";
import type { Tab } from "../browser/tab";
import { parseKey } from "./keys";
import { call, callForObject, describe, DESCRIBE, type Described, liveNode, type Node } from "./node";
import { aim, clickAtPoint, mouse, type Point, scrollToCentre, toggleHiddenControl } from "./pointing";
import { wheelScroll } from "./scrolling";
import { setSlider } from "./slider";
import { drag as dragTo, type DragTarget } from "./drag";
import type { RefTable } from "./refs";
import { ANNOUNCES_SUGGESTIONS, suggestionNote, typeKeys, VISIBLE_SUGGESTIONS } from "./typing";

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

/** Role and name of the element behind a ref, read live from the page. */
export async function describeRef(tab: Tab, refs: RefTable, ref: string): Promise<Described | undefined> {
  try {
    return await call<Described>(tab, await liveNode(tab, refs, ref), DESCRIBE);
  } catch {
    return undefined;
  }
}

export function click(tab: Tab, refs: RefTable, ref: string): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    const label = await describe(tab, node);
    let point: Point;
    try {
      point = await aim(tab, node);
    } catch (error) {
      if (await toggleHiddenControl(tab, node, error)) return ok(`clicked ${label}${await checkedState(tab, node)}`);
      throw error;
    }
    await clickAtPoint(tab, point);
    return ok(`clicked ${label}`);
  });
}

async function checkedState(tab: Tab, node: Node): Promise<string> {
  const checked = await call<boolean>(tab, node, "function () { return this.checked; }").catch(() => undefined);
  return checked === undefined ? "" : checked ? " (now checked)" : " (now not checked)";
}

/** Drags an element onto another element, or by an offset in pixels. */
export function drag(tab: Tab, refs: RefTable, ref: string, to: DragTarget): Promise<ActionResult> {
  return attempt(async () => ok(await dragTo(tab, refs, ref, to)));
}

export function hover(tab: Tab, refs: RefTable, ref: string): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    await mouse(tab, "mouseMoved", await aim(tab, node, { hitTest: false }));
    return ok(`hovered ${await describe(tab, node)}`);
  });
}

/** Replaces the field's contents with text, as a person selecting all and typing would. */
export function type(tab: Tab, refs: RefTable, ref: string, text: string, opts: { submit?: boolean } = {}): Promise<ActionResult> {
  return attempt(async () => {
    const node = await liveNode(tab, refs, ref);
    const slider = await setSlider(tab, node, text);
    if (slider) return slider;
    const special = await setSpecialInput(tab, node, text);
    if (special) return special;
    if (node.owner !== undefined) await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.owner }).catch(() => undefined);
    await tab.sendIn(node.session, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }).catch(() => undefined);
    await tab.sendIn(node.session, "DOM.focus", { backendNodeId: node.backendNodeId });
    await call(tab, node, "function () { if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) document.execCommand('selectAll'); }");
    // Number boxes, passwords and plain text areas never suggest, so they skip the wait for a list.
    const watch = !opts.submit && text !== "" && !(await call<boolean>(tab, node, "function () { return this.type === 'password' || this.type === 'number' || (this.tagName === 'TEXTAREA' && !this.getAttribute('role') && !this.getAttribute('aria-autocomplete')); }"));
    const suggestions = () => call<string[]>(tab, node, VISIBLE_SUGGESTIONS);
    const before = watch ? await suggestions() : [];
    if (text) await typeKeys(tab, text);
    else await press(tab, "Delete");
    if (opts.submit) await press(tab, "Enter");
    const note = watch ? await suggestionNote(suggestions, before, await call<boolean>(tab, node, ANNOUNCES_SUGGESTIONS)) : "";
    return ok(`typed ${text.length} characters${opts.submit ? " and pressed Enter" : ""}${note}`);
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
      await scrollToCentre(tab, await liveNode(tab, opts.refs, opts.ref));
      return ok(`scrolled ${opts.ref} into view`);
    }
    return ok(await wheelScroll(tab, opts.dy));
  });
}

/**
 * Sites often hide the real <input type=file> behind a styled button or drop zone. Find the input
 * that belongs to the element the agent chose: the element itself, the control of its label, an
 * input inside it, or the one file input in its nearest enclosing section.
 */
const FILE_INPUT_FOR = `function () {
  const isFile = (el) => el && el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file';
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  if (isFile(el)) return el;
  const label = el.closest('label');
  if (label && isFile(label.control)) return label.control;
  const inside = el.querySelectorAll('input[type=file]');
  if (inside.length === 1) return inside[0];
  for (let up = el.parentElement, depth = 0; up && depth < 4; up = up.parentElement, depth++) {
    const found = up.querySelectorAll('input[type=file]');
    if (found.length === 1) return found[0];
    if (found.length > 1) return null;
  }
  const all = document.querySelectorAll('input[type=file]');
  return all.length === 1 ? all[0] : null;
}`;

function fileInputFor(tab: Tab, node: Node): Promise<string | undefined> {
  return callForObject(tab, node, FILE_INPUT_FOR);
}

export function upload(tab: Tab, refs: RefTable, ref: string, paths: string[]): Promise<ActionResult> {
  return attempt(async () => {
    const missing = paths.filter((p) => !existsSync(p));
    if (missing.length) return fail(`file not found: ${missing.join(", ")}`);
    const node = await liveNode(tab, refs, ref);
    const input = await fileInputFor(tab, node);
    if (!input) return fail(`${ref} is not a file upload control, and no file input belongs to it`);
    await tab.sendIn(node.session, "DOM.setFileInputFiles", { files: paths, objectId: input });
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
