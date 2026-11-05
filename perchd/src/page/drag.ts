/**
 * Dragging, as a person does with the mouse: press on the element, move in small steps, release.
 * Pages built on pointer events (sliders, sortable lists, maps) see ordinary mouse moves. Pages
 * that use HTML5 drag and drop see a real drag: Chromium hands the drag to us, and we deliver
 * dragenter, dragover and drop at the target with the drag's own data.
 */

import type { Tab } from "../browser/tab";
import { aim, mouse, type Point } from "./pointing";
import { liveNode } from "./node";
import type { RefTable } from "./refs";

const STEPS = 12;
const STEP_MS = 16;

type DragData = { items: { mimeType: string; data: string }[]; dragOperationsMask: number; files?: string[] };

export type DragTarget = { ref: string } | { dx: number; dy: number };

export async function drag(tab: Tab, refs: RefTable, from: string, to: DragTarget): Promise<string> {
  const source = await liveNode(tab, refs, from);
  const start = await aim(tab, source);
  const end = "ref" in to ? await aim(tab, await liveNode(tab, refs, to.ref), { hitTest: false }) : { x: start.x + to.dx, y: start.y + to.dy };
  let data: DragData | null = null;
  const stop = tab.conn.on("Input.dragIntercepted", (p: { data: DragData }, sid) => {
    if (sid === tab.session) data = p.data;
  });
  await tab.send("Input.setInterceptDrags", { enabled: true });
  try {
    await mouse(tab, "mouseMoved", start);
    await mouse(tab, "mousePressed", start, { button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= STEPS && !data; i++) {
      await mouse(tab, "mouseMoved", lerp(start, end, i / STEPS), { button: "left", buttons: 1 });
      await Bun.sleep(STEP_MS);
    }
    if (data) await dropAt(tab, end, data);
    await mouse(tab, "mouseReleased", end, { button: "left", buttons: 0, clickCount: 1 });
  } finally {
    stop();
    await tab.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
  }
  return `dragged ${from} to ${"ref" in to ? to.ref : `${Math.round(end.x)}, ${Math.round(end.y)}`}`;
}

async function dropAt(tab: Tab, point: Point, data: DragData): Promise<void> {
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await tab.send("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data, modifiers: 0 });
  }
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
