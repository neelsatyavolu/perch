/**
 * Typing as a person does: one key event per character, so pages that listen for keydown or keyup
 * (suggestion lists, search-as-you-type, input masks) react. Text inserted in one step fires only
 * an input event, and many suggestion widgets never open for it.
 */

import type { Tab } from "../browser/tab";
import { keyForChar } from "./keys";

/** Longer text goes in at once, with only its last character typed as a key. */
const KEY_BY_KEY_LIMIT = 80;
/** How long to look for a suggestion list after typing: longer for fields that announce one. */
const SUGGEST_WAIT_MS = { announced: 1500, plain: 300 };
const POLL_MS = 100;
const LISTED = 5;
const SHIFT = 8;

export async function typeKeys(tab: Tab, text: string): Promise<void> {
  const keyed = text.length > KEY_BY_KEY_LIMIT ? text.slice(-1) : text;
  if (keyed.length < text.length) await tab.send("Input.insertText", { text: text.slice(0, -1) });
  for (const ch of keyed) {
    const def = keyForChar(ch);
    if (!def) {
      await tab.send("Input.insertText", { text: ch });
      continue;
    }
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers: def.shift ? SHIFT : 0 };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: def.text, unmodifiedText: def.text });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

/** Called on the field: whether it says it has a suggestion list (ARIA, datalist, autocomplete off). */
export const ANNOUNCES_SUGGESTIONS = `function () {
  const a = (n) => this.getAttribute && this.getAttribute(n);
  return Boolean(a('role') === 'combobox' || a('aria-autocomplete') || a('aria-haspopup') || a('aria-controls') || a('list') || a('autocomplete') === 'off');
}`;

/** Called on the field: the visible suggestion-like items in its document, as short text. */
export const VISIBLE_SUGGESTIONS = `function () {
  const doc = this.ownerDocument || document;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const sel = '[role=option], [role=listbox] li, [class*=suggest i] li, [class*=autocomplete i] li, [class*=typeahead i] li, [id*=suggest i] li, [id*=autocomplete i] li, .pac-item';
  const out = [];
  for (const el of doc.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 50);
}`;

/**
 * Waits briefly for suggestions that were not there before typing. Returns a note for the model,
 * or "" when none appeared.
 */
export async function suggestionNote(read: () => Promise<string[]>, before: string[], announced: boolean): Promise<string> {
  const known = new Set(before);
  const deadline = Date.now() + (announced ? SUGGEST_WAIT_MS.announced : SUGGEST_WAIT_MS.plain);
  let fresh: string[] = [];
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    fresh = (await read().catch(() => [])).filter((t) => !known.has(t));
    if (fresh.length > 0) break;
  }
  if (fresh.length === 0) return "";
  // Server-backed lists often fill in over a few frames; read once more when it settles.
  await Bun.sleep(POLL_MS);
  const settled = (await read().catch(() => [])).filter((t) => !known.has(t));
  const items = settled.length >= fresh.length ? settled : fresh;
  const shown = items.slice(0, LISTED).map((t) => `"${t}"`).join(", ");
  const more = items.length > LISTED ? ", …" : "";
  return `; ${items.length} suggestion${items.length === 1 ? "" : "s"} appeared: ${shown}${more}. Click the one you want; many sites ignore typed text until you do`;
}
