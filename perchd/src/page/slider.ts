/**
 * Setting sliders by value. A native range input takes its value the way the browser's own UI
 * sets it (value setter, then input and change). A custom ARIA slider is moved with the arrow
 * keys, as a keyboard user would, until it shows the value asked for.
 */

import type { Tab } from "../browser/tab";
import { parseKey } from "./keys";
import { call, type Node } from "./node";

const MAX_PRESSES = 400;

type SliderState = { kind: "range" | "aria" | "none"; now: number; min: number; max: number };

const STATE = `function () {
  if (this.tagName === 'INPUT' && this.type === 'range') return { kind: 'range', now: Number(this.value), min: Number(this.min || 0), max: Number(this.max || 100) };
  if (this.getAttribute('role') !== 'slider') return { kind: 'none', now: 0, min: 0, max: 0 };
  const n = (a, d) => { const v = parseFloat(this.getAttribute(a)); return Number.isFinite(v) ? v : d; };
  return { kind: 'aria', now: n('aria-valuenow', NaN), min: n('aria-valuemin', 0), max: n('aria-valuemax', 100) };
}`;

const SET_RANGE = `function (v) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(this, v);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return Number(this.value);
}`;

export type SliderResult = { ok: true; note: string } | { ok: false; error: string };

/** Sets a slider to a number. Returns null when the element is not a slider. */
export async function setSlider(tab: Tab, node: Node, text: string): Promise<SliderResult | null> {
  const state = await call<SliderState>(tab, node, STATE);
  if (state.kind === "none") return null;
  const want = Number(text.replace(/[,\s$€£%]/g, ""));
  if (!Number.isFinite(want)) return { ok: false, error: `this is a slider from ${state.min} to ${state.max}; give a number` };
  if (state.kind === "range") {
    const applied = await call<number>(tab, node, SET_RANGE, [String(want)]);
    return { ok: true, note: `set the slider to ${applied}${applied !== want ? ` (the nearest value it allows to ${want})` : ""}` };
  }
  return moveWithKeys(tab, node, state, want);
}

async function moveWithKeys(tab: Tab, node: Node, state: SliderState, want: number): Promise<SliderResult> {
  if (!Number.isFinite(state.now)) return { ok: false, error: "this slider does not report its value; drag its handle instead" };
  await tab.sendIn(node.session, "DOM.focus", { backendNodeId: node.backendNodeId }).catch(() => undefined);
  const target = Math.min(state.max, Math.max(state.min, want));
  let now = state.now;
  for (let i = 0; i < MAX_PRESSES && now !== target; i++) {
    const key = now < target ? "ArrowRight" : "ArrowLeft";
    await pressKey(tab, key);
    const next = (await call<SliderState>(tab, node, STATE)).now;
    if (next === now) return { ok: false, error: `the slider stopped at ${now}; it does not move with the arrow keys, so drag its handle instead` };
    // Overshot a coarse step: stop at the closest value on the side we came from.
    if ((key === "ArrowRight" && next > target) || (key === "ArrowLeft" && next < target)) {
      if (Math.abs(next - target) < Math.abs(now - target)) now = next;
      else await pressKey(tab, key === "ArrowRight" ? "ArrowLeft" : "ArrowRight");
      break;
    }
    now = next;
  }
  return { ok: true, note: `set the slider to ${now}${now !== want ? ` (the nearest value it allows to ${want})` : ""}` };
}

async function pressKey(tab: Tab, combo: string): Promise<void> {
  const { def } = parseKey(combo)!;
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode };
  await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
