/** Things the agent can do to a page. Every action reports success or a plain error; none throws. */

import { existsSync } from "node:fs";
import type { Tab } from "../browser/tab";
import { parseKey } from "./keys";
import { call, callForObject, describe, DESCRIBE, type Described, liveNode, type Node } from "./node";
import { aim, clickAtPoint, clickHiddenTarget, mouse, type Point, SCRIPT_CLICK, scrollToCentre, toggleHiddenControl } from "./pointing";
import { wheelScroll } from "./scrolling";
import { selectFromListbox } from "./listbox";
import { setSlider } from "./slider";
import { drag as dragTo, type DragTarget } from "./drag";
import type { RefTable } from "./refs";
import { IS_SECRET_JS, rememberedSecrets, secretKey } from "./secrets";
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
    const refusal = await clickRefusal(tab, node, label);
    if (refusal) return fail(refusal);
    const { result, picker } = await keepingFilePickerClosed(tab, () => clickNode(tab, node, label));
    if (!picker || !result.ok) return result;
    return ok(`${result.note}; it opened a file picker, which Perch kept closed: to attach files, use upload with ${ref}`);
  });
}

async function clickNode(tab: Tab, node: Node, label: string): Promise<ActionResult> {
  let point: Point;
  try {
    point = await aim(tab, node);
  } catch (error) {
    if (await toggleHiddenControl(tab, node, error)) return ok(`clicked ${label}${await checkedState(tab, node)}`);
    if (await clickHiddenTarget(tab, node, error)) return ok(`clicked ${label} ${SCRIPT_CLICK}`);
    throw error;
  }
  await clickAtPoint(tab, point);
  return ok(`clicked ${label}`);
}

/** How long after a click a page's script may still open a file picker. */
const PICKER_GRACE_MS = 100;

/**
 * Runs a click with the browser's file picker held back. The picker is a window of its own that
 * the agent can neither see nor use, and it would wait there for the user; upload sets files
 * directly instead. Only the click is covered, so the user's own clicks in the tab still open it.
 */
async function keepingFilePickerClosed(tab: Tab, work: () => Promise<ActionResult>): Promise<{ result: ActionResult; picker: boolean }> {
  let picker = false;
  const off = tab.conn.on("Page.fileChooserOpened", (_p, sid) => {
    if (sid === tab.session) picker = true;
  });
  const intercepting = await tab.send("Page.setInterceptFileChooserDialog", { enabled: true }).then(() => true, () => false);
  try {
    const result = await work();
    if (intercepting) await Bun.sleep(PICKER_GRACE_MS);
    return { result, picker };
  } finally {
    off();
    if (intercepting) await tab.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  }
}

const disabled = (label: string) => `${label} is disabled; the page enables it once it has what it needs (fill the required fields or make the choices before it)`;

/**
 * What a click would not do: a disabled control ignores it, and a native dropdown opens a menu
 * drawn outside the page, which the snapshot and screenshots never show.
 */
const CLICK_BLOCKED = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  if (el.matches(':disabled')) return { disabled: true };
  if (el.tagName === 'SELECT' && !el.multiple && el.size <= 1) return { options: [...el.options].map((o) => o.label.trim() + (o.disabled ? ' (disabled)' : '')) };
  return null;
}`;

async function clickRefusal(tab: Tab, node: Node, label: string): Promise<string | null> {
  const blocked = await call<{ disabled?: true; options?: string[] } | null>(tab, node, CLICK_BLOCKED);
  if (!blocked) return null;
  if (blocked.disabled) return disabled(label);
  return `${label} is a dropdown; use select with one of its options: ${(blocked.options ?? []).join(", ")}`;
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
    const chosen = await liveNode(tab, refs, ref);
    const slider = await setSlider(tab, chosen, text);
    if (slider) return slider;
    const node = await innerField(tab, chosen);
    const special = await setSpecialInput(tab, node, text);
    if (special) return special;
    // Typing at a link or a button would send the keys to whatever has focus, where a page's own
    // keyboard shortcuts could act; only something that takes text gets them.
    const state = await call<"text" | "readonly" | "disabled" | "none">(tab, node, FIELD_STATE);
    if (state !== "text") return fail(notTypable(await describe(tab, chosen), state));
    if (node.owner !== undefined) await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.owner }).catch(() => undefined);
    await tab.sendIn(node.session, "DOM.scrollIntoViewIfNeeded", { objectId: node.objectId }).catch(() => undefined);
    await tab.sendIn(node.session, "DOM.focus", { objectId: node.objectId });
    await call(tab, node, "function () { if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) document.execCommand('selectAll'); }");
    // Number boxes, passwords and plain text areas never suggest, so they skip the wait for a list.
    const watch = !opts.submit && text !== "" && !(await call<boolean>(tab, node, "function () { return this.type === 'password' || this.type === 'number' || (this.tagName === 'TEXTAREA' && !this.getAttribute('role') && !this.getAttribute('aria-autocomplete')); }"));
    const suggestions = () => call<string[]>(tab, node, VISIBLE_SUGGESTIONS);
    const before = watch ? await suggestions() : [];
    if (text) await typeKeys(tab, text);
    else await press(tab, "Delete");
    if (opts.submit) await press(tab, "Enter");
    // What the field shows is checked before suggestions are waited for, which can take a second.
    const shown = opts.submit || !text ? "" : await shownNote(tab, node, text);
    const note = watch ? await suggestionNote(suggestions, before, await call<boolean>(tab, node, ANNOUNCES_SUGGESTIONS)) : "";
    return ok(`typed ${text.length} characters${opts.submit ? " and pressed Enter" : ""}${shown}${note}`);
  });
}

const NOT_TEXT_INPUTS = "['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'hidden', 'file', 'color', 'range']";

/** Whether the element takes typed text ("text"), and if not, why: a field that is read-only or disabled, or no field at all. */
const FIELD_STATE = `function () {
  const field = this.isContentEditable || this.tagName === 'TEXTAREA' || (this.tagName === 'INPUT' && !${NOT_TEXT_INPUTS}.includes(this.type));
  if (!field) return ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(this.getAttribute('role') || '') ? 'text' : 'none';
  if (this.isContentEditable) return 'text';
  return this.disabled ? 'disabled' : this.readOnly ? 'readonly' : 'text';
}`;

function notTypable(label: string, state: "readonly" | "disabled" | "none"): string {
  if (state === "disabled") return disabled(label);
  // Custom date pickers and dropdowns often draw a read-only field that opens a panel when clicked.
  if (state === "readonly") return `${label} is read-only; click it to open its picker, then choose from what appears`;
  return `${label} isn't a text field; type into a field, or click this instead`;
}

/**
 * The text field that belongs to the element the agent chose, when that element is not one
 * itself: the control of a label, or the one field inside a wrapper (an ARIA combobox drawn as a
 * box around its input, as react-select and many date and place pickers do).
 */
const INNER_FIELD = `function () {
  const takes = (el) => el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !${NOT_TEXT_INPUTS}.includes(el.type));
  if (takes(this)) return null;
  if (this.tagName === 'LABEL' && this.control && takes(this.control)) return this.control;
  const inside = [...this.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable=false])')].filter((el) => takes(el) && el.getClientRects().length > 0);
  return inside.length === 1 ? inside[0] : null;
}`;

async function innerField(tab: Tab, node: Node): Promise<Node> {
  const inner = await callForObject(tab, node, INNER_FIELD).catch(() => undefined);
  if (!inner) return node;
  // The field's own node id, so a field once shown as secret is still known as one.
  const { node: described } = await tab.sendIn<{ node: { backendNodeId: number } }>(node.session, "DOM.describeNode", { objectId: inner });
  return { ...node, objectId: inner, backendNodeId: described.backendNodeId };
}

/**
 * What a field shows, unless it holds a secret; null for a secret. Rich editors are not read:
 * they turn text into lists, links and chips, and some (Google Docs) empty their input after each key.
 */
const SHOWN_TEXT = `function (remembered) {
  if (remembered || (${IS_SECRET_JS})(this)) return null;
  if (this.tagName !== 'INPUT' && this.tagName !== 'TEXTAREA') return null;
  return String(this.value ?? '');
}`;

/**
 * Input masks reformat typed text, maxlength cuts it, and some pages refuse it; the model is told
 * what the field shows when that differs from what it typed. Secret fields are never read.
 */
async function shownNote(tab: Tab, node: Node, text: string): Promise<string> {
  const remembered = rememberedSecrets(tab).has(secretKey(node.backendNodeId, node.session));
  const shown = await call<string | null>(tab, node, SHOWN_TEXT, [remembered]).catch(() => null);
  if (shown === null) return "";
  const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();
  if (squeeze(shown) === squeeze(text)) return "";
  if (!squeeze(shown)) return "; the field is still empty: the page did not take the text. Click the field and use type_text, or check for a message near it";
  const cut = shown.length > SHOWN_LIMIT ? `${shown.slice(0, SHOWN_LIMIT)}…` : shown;
  return `; the field now shows "${cut}"`;
}

const SHOWN_LIMIT = 200;

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
    if (!(await call<boolean>(tab, node, "function () { return this.tagName === 'SELECT'; }"))) {
      return (await selectFromListbox(tab, node, choice)) ?? fail(`${await describe(tab, node)} isn't a dropdown; click it instead`);
    }
    const result = await call<{ chosen?: string; options?: string[]; disabled?: string }>(
      tab,
      node,
      `function (choice) {
        const opts = Array.from(this.options || []);
        const want = choice.trim().toLowerCase();
        const hit = opts.find(o => o.label.trim().toLowerCase() === want) || opts.find(o => o.value.toLowerCase() === want);
        if (!hit) return { options: opts.map(o => o.label.trim()) };
        if (hit.disabled) return { disabled: hit.label.trim(), options: opts.filter(o => !o.disabled).map(o => o.label.trim()) };
        this.value = hit.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { chosen: hit.label.trim() };
      }`,
      [choice],
    );
    if (result.disabled !== undefined) return fail(`option "${result.disabled}" is disabled; choose another: ${(result.options ?? []).join(", ")}`);
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
      // With dy too, the wheel turns over the element, so a side panel or a dialog's list scrolls.
      if (opts.dy !== undefined) return ok(await wheelScroll(tab, opts.dy, await aim(tab, node, { hitTest: false })));
      await scrollToCentre(tab, node);
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

/** Waits until the text is on the page, or with `gone` until it is not (a "Loading…" message). */
export function waitFor(tab: Tab, opts: { text?: string; timeoutMs?: number; gone?: boolean }): Promise<ActionResult> {
  return attempt(async () => {
    const timeout = opts.timeoutMs ?? 10_000;
    const text = opts.text ?? "";
    const gone = opts.gone === true;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const there = await tab.evaluate<boolean>(`document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`);
      if (there !== gone) return ok(gone ? `"${text}" is gone from the page` : `"${text}" is on the page`);
      await Bun.sleep(100);
    }
    return fail(`waited ${timeout / 1000}s; "${text}" ${gone ? "is still on the page" : "did not appear"}`);
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
