/**
 * Scrolling with the mouse wheel, and saying what happened: how far the page (or the panel under
 * the pointer) moved, whether more content loaded, and whether the end was reached. Lists that
 * load as you scroll are common, and an agent that cannot tell "loading" from "the end" stops early.
 */

import type { Tab } from "../browser/tab";
import { mouse } from "./pointing";

type ScrollState = { top: number; height: number; client: number; panel: boolean };

/** What the wheel at a point scrolls: the nearest scrollable box under it, or the page. */
const STATE_AT = (x: number, y: number) => `(() => {
  const page = document.scrollingElement || document.documentElement;
  let el = document.elementFromPoint(${x}, ${y});
  for (; el && el !== page && el !== document.body; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2) break;
  }
  const box = el && el !== document.body && el !== page ? el : page;
  return { top: box.scrollTop, height: box.scrollHeight, client: box.clientHeight, panel: box !== page };
})()`;

const MOVE_WAIT_MS = 500;
/** How long to wait at the end for a list that loads more as you reach it. */
const GROW_WAIT_MS = 1500;
const POLL_MS = 50;

const atEnd = (s: ScrollState) => s.top + s.client >= s.height - 2;

export async function wheelScroll(tab: Tab, dy: number | undefined): Promise<string> {
  const [w, h] = await tab.evaluate<[number, number]>("[innerWidth, innerHeight]");
  const point = { x: Math.round(w / 2), y: Math.round(h / 2) };
  const read = () => tab.evaluate<ScrollState>(STATE_AT(point.x, point.y));
  const before = await read();
  const delta = dy ?? h * 0.8;
  await mouse(tab, "mouseWheel", point, { deltaX: 0, deltaY: delta });
  // Wait for it to start moving, then for it to stop (wheel scrolling can be animated).
  let after = before;
  for (const started = Date.now(); Date.now() - started < MOVE_WAIT_MS; ) {
    await Bun.sleep(POLL_MS);
    const next = await read();
    if (next.top !== before.top && next.top === after.top) break;
    after = next;
  }
  const where = after.panel ? "the scrollable panel" : "the page";
  if (after.top === before.top) {
    return delta > 0 && atEnd(after) ? `${where} did not move: it is at the end` : delta < 0 && after.top <= 0 ? `${where} did not move: it is at the top` : `${where} did not move`;
  }
  const position = `scrolled ${where} to ${Math.round(after.top)} of ${Math.round(after.height)} px`;
  if (delta <= 0 || !atEnd(after)) return position;
  // At the end: give a lazy list time to add more.
  let grown = after;
  for (const started = Date.now(); Date.now() - started < GROW_WAIT_MS; ) {
    await Bun.sleep(POLL_MS);
    grown = await read();
    if (grown.height > after.height) break;
  }
  return grown.height > after.height
    ? `${position}; more content loaded at the end (now ${Math.round(grown.height)} px), so scroll again for more`
    : `${position}; this is the end of ${where}`;
}
