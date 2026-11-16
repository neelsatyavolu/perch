/**
 * Choosing from custom dropdowns: an ARIA combobox, a button that pops up a listbox, or a listbox
 * itself. The control is opened with a click, as a person would; then its listbox is found (the
 * one it names in aria-controls or aria-owns, or the visible listbox nearest to it) and the option
 * whose name matches is clicked.
 */

import type { Tab } from "../browser/tab";
import { call, callForObject, describe, type Node } from "./node";
import { aim, clickAtPoint } from "./pointing";
import { typeKeys } from "./typing";

export type ListboxResult = { ok: true; note: string } | { ok: false; error: string };

/** How long a listbox and its options get to appear after the control is opened. */
const WAIT_MS = 1500;

/** What the control is: a dropdown to open, an open dropdown or a listbox, or neither. */
const KIND = `function () {
  const role = this.getAttribute('role') || '';
  if (role === 'listbox') return 'open';
  if (role !== 'combobox' && (this.getAttribute('aria-haspopup') || '').toLowerCase() !== 'listbox') return 'none';
  return this.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed';
}`;

/** Shared helpers for the page functions below: visibility, and an option's accessible name. */
const HELPERS = `
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.textContent).join(' ') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const options = (box) => [...box.querySelectorAll('[role=option]')].filter(visible);
`;

/** The listbox the control opened: itself, one it names, one inside it, or the nearest visible one. */
const LISTBOX_FOR = `function () {
  ${HELPERS}
  if (this.getAttribute('role') === 'listbox') return this;
  const root = this.getRootNode();
  const byId = (id) => (root.getElementById && root.getElementById(id)) || document.getElementById(id);
  const owners = [this, this.closest('[role=combobox]')].filter(Boolean);
  for (const owner of owners) {
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (owner.getAttribute(attr) || '').split(/\\s+/).filter(Boolean)) {
        const el = byId(id);
        if (!el || !visible(el)) continue;
        if (el.getAttribute('role') === 'listbox') return el;
        const inner = [...el.querySelectorAll('[role=listbox]')].find(visible);
        if (inner) return inner;
        if (options(el).length) return el;
      }
    }
  }
  const found = new Set([...(root.querySelectorAll ? root.querySelectorAll('[role=listbox]') : []), ...document.querySelectorAll('[role=listbox]')]);
  const boxes = [...found].filter(visible);
  const inside = boxes.find((b) => this.contains(b));
  if (inside) return inside;
  const r = this.getBoundingClientRect();
  const gap = (b) => {
    const q = b.getBoundingClientRect();
    const dx = Math.max(q.left - r.right, r.left - q.right, 0);
    const dy = Math.max(q.top - r.bottom, r.top - q.bottom, 0);
    return dx * dx + dy * dy;
  };
  return boxes.sort((a, b) => gap(a) - gap(b))[0] || null;
}`;

/** The option matching the choice: exact name, then any case, then a name that contains it. */
const MATCH = `function (choice) {
  ${HELPERS}
  const all = options(this);
  const names = all.map(text);
  const want = choice.trim();
  const lower = want.toLowerCase();
  let i = names.indexOf(want);
  if (i < 0) i = names.findIndex((n) => n.toLowerCase() === lower);
  if (i < 0 && lower) i = names.findIndex((n) => n.toLowerCase().includes(lower));
  return i < 0 ? null : all[i];
}`;

const NAMES = `function () {
  ${HELPERS}
  return options(this).map(text);
}`;

const NAME = `function () {
  ${HELPERS}
  return text(this);
}`;

/**
 * The text field of a type-to-search combobox: the control itself, or the one field inside it.
 * Null for a combobox that is a button, which only opens.
 */
const SEARCH_FIELD = `function () {
  const takes = (el) => (el.tagName === 'INPUT' && /^(|text|search)$/.test(el.getAttribute('type') || '')) || el.isContentEditable;
  if (takes(this)) return this.disabled || this.readOnly ? null : this;
  const inside = [...this.querySelectorAll('input')].filter((el) => takes(el) && !el.disabled && !el.readOnly && el.getClientRects().length > 0);
  return inside.length === 1 ? inside[0] : null;
}`;

/** Types the choice into a type-to-search combobox, replacing its text. False when it has no field. */
async function searchFor(tab: Tab, node: Node, choice: string): Promise<boolean> {
  const field = await callForObject(tab, node, SEARCH_FIELD).catch(() => undefined);
  if (!field) return false;
  await tab.sendIn(node.session, "DOM.focus", { objectId: field });
  await call(tab, { ...node, objectId: field }, "function () { if (typeof this.select === 'function') this.select(); else document.execCommand('selectAll'); }");
  await typeKeys(tab, choice);
  return true;
}

/** How long an opened combobox may show no matching option before the choice is typed into it. */
const TYPE_AFTER_MS = 300;

/** Picks an option in a custom dropdown. Returns null when the element is not one. */
export async function selectFromListbox(tab: Tab, node: Node, choice: string): Promise<ListboxResult | null> {
  const kind = await call<"open" | "closed" | "none">(tab, node, KIND);
  if (kind === "none") return null;
  const label = await describe(tab, node);
  if (kind === "closed") await clickAtPoint(tab, await aim(tab, node));
  let deadline = Date.now() + WAIT_MS;
  const typeAt = Date.now() + TYPE_AFTER_MS;
  let typed = false;
  let searched = false;
  for (;;) {
    const listbox = await callForObject(tab, node, LISTBOX_FOR);
    const box = listbox ? { ...node, objectId: listbox } : null;
    const option = box ? await callForObject(tab, box, MATCH, [choice]) : undefined;
    if (option) {
      const target = { ...node, objectId: option };
      const name = await call<string>(tab, target, NAME);
      await clickAtPoint(tab, await aim(tab, target));
      return { ok: true, note: `selected "${name}"` };
    }
    // Long lists (cities, airports, people) show their options only for what is typed.
    if (!typed && Date.now() >= typeAt) {
      typed = true;
      searched = await searchFor(tab, node, choice);
      if (searched) deadline = Date.now() + WAIT_MS;
    }
    if (Date.now() >= deadline) {
      if (!box && searched) return { ok: false, error: `typed "${choice}" into ${label}, but no option appeared; try a shorter or different spelling` };
      if (!box) return { ok: false, error: `opened ${label}, but no list of options appeared` };
      return { ok: false, error: `no option "${choice}"; options are: ${(await call<string[]>(tab, box, NAMES)).join(", ")}` };
    }
    await Bun.sleep(100);
  }
}
