/**
 * Finding where to point the mouse at an element: in view, visible, and not covered by something
 * else. Pages often scroll smoothly, pin headers over content, or hide native controls behind
 * styled labels; each of those is handled here so a click lands where a person's would.
 */

import type { Tab } from "../browser/tab";
import { call, callForObject, describe, type Node } from "./node";

export type Point = { x: number; y: number };

const STABLE_TRIES = 8;
const STABLE_MS = 40;
/** Scrolls without animation, whatever the page's scroll-behavior says. */
const SCROLL_TO_CENTRE = "function () { const el = this.nodeType === 1 ? this : this.parentElement; if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }";
const CLIPPED = "the element is hidden or clipped on screen; scroll its container or open the panel it is in";

export async function mouse(tab: Tab, type: string, point: Point, extra: object = {}): Promise<void> {
  await tab.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra });
}

export async function clickAtPoint(tab: Tab, point: Point): Promise<void> {
  await mouse(tab, "mouseMoved", point);
  await mouse(tab, "mousePressed", point, { button: "left", buttons: 1, clickCount: 1 });
  await mouse(tab, "mouseReleased", point, { button: "left", buttons: 0, clickCount: 1 });
}

/** Top-left of a cross-site iframe's content box in page coordinates. */
export async function frameOffset(tab: Tab, owner: number | undefined): Promise<Point> {
  if (owner === undefined) return { x: 0, y: 0 };
  const { quads } = await tab.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: owner });
  const q = quads[0];
  return q ? { x: Math.min(q[0]!, q[6]!), y: Math.min(q[1]!, q[3]!) } : { x: 0, y: 0 };
}

/** The centre of the element's first box with an area, in its own frame's coordinates. */
async function boxCentre(tab: Tab, node: Node): Promise<Point | null> {
  const { quads } = await tab
    .sendIn<{ quads: number[][] }>(node.session, "DOM.getContentQuads", { objectId: node.objectId })
    .catch(() => ({ quads: [] as number[][] }));
  const quad = quads.find((q) => Math.abs((q[4]! - q[0]!) * (q[5]! - q[1]!)) > 1);
  return quad ? { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 } : null;
}

/** The element's centre in page coordinates, read until it stops moving (scroll animations). */
async function settledCentre(tab: Tab, node: Node): Promise<Point | null> {
  let last = await boxCentre(tab, node);
  for (let i = 0; i < STABLE_TRIES && last; i++) {
    await Bun.sleep(STABLE_MS);
    const next = await boxCentre(tab, node);
    if (next && Math.abs(next.x - last.x) < 1 && Math.abs(next.y - last.y) < 1) break;
    last = next;
  }
  if (!last) return null;
  const offset = await frameOffset(tab, node.owner);
  return { x: offset.x + last.x, y: offset.y + last.y };
}

async function inViewport(tab: Tab, point: Point): Promise<boolean> {
  const [w, h] = await tab.evaluate<[number, number]>("[innerWidth, innerHeight]");
  return point.x >= 0 && point.y >= 0 && point.x < w && point.y < h;
}

export async function scrollToCentre(tab: Tab, node: Node): Promise<void> {
  if (node.owner !== undefined) {
    const { object } = await tab.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: node.owner }).catch(() => ({ object: {} as { objectId?: string } }));
    if (object.objectId) await call(tab, { objectId: object.objectId }, SCROLL_TO_CENTRE).catch(() => undefined);
  }
  await call(tab, node, SCROLL_TO_CENTRE).catch(() => undefined);
}

/**
 * The element a click at a viewport point would reach, from the target's own document: the point
 * is moved into same-process iframes, and open shadow roots are entered. (DOM.getNodeForLocation
 * takes document coordinates, so it misses on any scrolled page; elementFromPoint does not.)
 */
const ELEMENT_AT = `function (x, y) {
  const deepest = (doc) => { let el = doc.elementFromPoint(x, y); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; } return el; };
  const frames = [];
  for (let w = (this.ownerDocument || document).defaultView; w && w.frameElement; w = w.parent) frames.unshift(w.frameElement);
  for (const f of frames) {
    // Each same-process iframe on the way down is hit-tested in its parent first, so an overlay
    // in a parent page counts as a cover.
    const hit = deepest(f.ownerDocument);
    if (hit !== f) return hit;
    const r = f.getBoundingClientRect(); x -= r.left + f.clientLeft; y -= r.top + f.clientTop;
  }
  return deepest(this.ownerDocument || document);
}`;

/**
 * Whether the hit is the target, inside it, inside a label for it (custom checkboxes), or the host
 * of a closed shadow root the target is in (elementFromPoint stops at such hosts).
 */
const RECEIVES = `function (other) {
  for (let n = other; n; n = n.parentNode || n.host) { if (n === this) return true; if (n.tagName === 'LABEL' && n.control === this) return true; }
  for (let n = this; n; ) { if (n.parentNode) n = n.parentNode; else if (n.host) { n = n.host; if (n === other) return true; } else break; }
  return false;
}`;

/** The element that would get a click at the point instead of the node, or undefined if the node gets it. */
async function coverAt(tab: Tab, node: { objectId: string; session?: string }, point: Point): Promise<string | undefined> {
  const hit = await callForObject(tab, node, ELEMENT_AT, [point.x, point.y]);
  if (!hit) throw new Error(CLIPPED);
  const { result } = await tab.sendIn<{ result: { value?: boolean } }>(node.session, "Runtime.callFunctionOn", {
    objectId: node.objectId,
    functionDeclaration: RECEIVES,
    arguments: [{ objectId: hit }],
    returnByValue: true,
  });
  return result.value ? undefined : hit;
}

/** Throws "covered by …" when another element would receive a click at the point. */
async function assertHittable(tab: Tab, target: Node, point: Point): Promise<void> {
  let cover: { objectId: string; session?: string } | undefined;
  if (target.owner !== undefined) {
    // A cross-site iframe: its element in the page must get the click before anything inside it.
    const { object } = await tab.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: target.owner });
    const ownerCover = object.objectId ? await coverAt(tab, { objectId: object.objectId }, point) : undefined;
    if (ownerCover) cover = { objectId: ownerCover };
  }
  if (!cover) {
    // Then hit-test in the frame's own coordinates and session.
    const offset = await frameOffset(tab, target.owner);
    const inner = await coverAt(tab, target, { x: point.x - offset.x, y: point.y - offset.y });
    if (inner) cover = { objectId: inner, session: target.session };
  }
  if (!cover) return;
  const what = await describe(tab, cover);
  // Dialogs and banners are the usual covers, and they can be closed.
  const hint = /^(dialog|alertdialog|iframe|div|section|aside|element)( |$)/.test(what) ? "; close it first (its Close, Reject or X button), or press Escape" : "";
  throw new Error(`covered by ${what}${hint}`);
}

/**
 * A point inside the element that a click would reach. Scrolls it to the middle of the screen when
 * it is off screen, or when something pinned (a header, a banner) covers it where it is.
 */
export async function aim(tab: Tab, node: Node, opts: { hitTest?: boolean } = {}): Promise<Point> {
  const hitTest = opts.hitTest ?? true;
  let point = await settledCentre(tab, node);
  let centred = false;
  if (!point || !(await inViewport(tab, point))) {
    await scrollToCentre(tab, node);
    centred = true;
    point = await settledCentre(tab, node);
  }
  if (!point) throw new Error("the element is not visible");
  if (!(await inViewport(tab, point))) throw new Error(CLIPPED);
  if (!hitTest) return point;
  try {
    await assertHittable(tab, node, point);
    return point;
  } catch (error) {
    if (centred) throw error;
    await scrollToCentre(tab, node);
    const again = await settledCentre(tab, node);
    if (!again) throw error;
    await assertHittable(tab, node, again);
    return again;
  }
}

/** For a native checkbox or radio: its first visible label, as a live object id. */
const VISIBLE_LABEL = `function () {
  if (this.tagName !== 'INPUT' || !/^(checkbox|radio)$/.test(this.type) || this.disabled) return null;
  return [...(this.labels || [])].find((l) => l.getClientRects().length > 0 && getComputedStyle(l).visibility !== 'hidden') || null;
}`;

/**
 * Sites hide native checkboxes and radios and draw their own. When the control itself cannot be
 * clicked, click its visible label as a person would, or toggle the control so the page gets its
 * normal click and change events. Returns false for anything that is not such a control.
 */
export async function toggleHiddenControl(tab: Tab, node: Node): Promise<boolean> {
  const isControl = await call<boolean>(tab, node, "function () { return this.tagName === 'INPUT' && /^(checkbox|radio)$/.test(this.type) && !this.disabled; }");
  if (!isControl) return false;
  const label = await callForObject(tab, node, VISIBLE_LABEL);
  if (label) {
    try {
      const point = await aim(tab, { ...node, objectId: label });
      await clickAtPoint(tab, point);
      return true;
    } catch {
      // Fall back to toggling the control itself.
    }
  }
  await call(tab, node, "function () { this.click(); }");
  return true;
}
