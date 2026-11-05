/** Element positions and form-field attributes from one DOMSnapshot call. */

import type { Tab } from "../browser/tab";

export type Rect = { y: number; h: number };
export type Layout = {
  rects: Map<number, Rect>;
  attrs: Map<number, Record<string, string>>;
  mainNodes: Set<number>;
  /** The document, html and body: their boxes are viewport-sized, so they never count as off screen. */
  roots: Set<number>;
  /**
   * Fixed and sticky elements and every ancestor of one. A cookie banner is often a fixed box
   * inside a container placed at the end of a long page; the container must not be pruned.
   */
  pinned: Set<number>;
  scrollY: number;
  viewHeight: number;
};

/** Elements whose attributes are kept: form fields (secret detection) and iframes (payment frames). */
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "IFRAME"]);
const ROOT_TAGS = new Set(["#document", "HTML", "BODY"]);

type Doc = {
  nodes: { backendNodeId: number[]; nodeName: number[]; attributes: number[][]; parentIndex: number[] };
  layout: { nodeIndex: number[]; bounds: number[][]; styles: number[][] };
};

export async function captureLayout(tab: Tab): Promise<Layout> {
  const [snap, view] = await Promise.all([
    tab.send<{ documents: Doc[]; strings: string[] }>("DOMSnapshot.captureSnapshot", { computedStyles: ["position"] }),
    tab.evaluate<[number, number]>("[scrollY, innerHeight]"),
  ]);
  const layout: Layout = { rects: new Map(), attrs: new Map(), mainNodes: new Set(), roots: new Set(), pinned: new Set(), scrollY: view[0], viewHeight: view[1] };
  snap.documents.forEach((doc, docIndex) => {
    const ids = doc.nodes.backendNodeId;
    if (docIndex === 0) for (const id of ids) layout.mainNodes.add(id);
    doc.layout.nodeIndex.forEach((nodeIndex, i) => {
      const bounds = doc.layout.bounds[i];
      const id = ids[nodeIndex];
      if (bounds && id !== undefined) layout.rects.set(id, { y: bounds[1] ?? 0, h: bounds[3] ?? 0 });
      const position = snap.strings[doc.layout.styles[i]?.[0] ?? -1];
      if (position === "fixed" || position === "sticky") {
        for (let n = nodeIndex; n >= 0 && n !== undefined; n = doc.nodes.parentIndex[n] ?? -1) {
          const nodeId = ids[n];
          if (nodeId === undefined || layout.pinned.has(nodeId)) break;
          layout.pinned.add(nodeId);
        }
      }
    });
    doc.nodes.nodeName.forEach((nameIndex, i) => {
      const id = ids[i];
      const tag = snap.strings[nameIndex] ?? "";
      if (id !== undefined && ROOT_TAGS.has(tag)) layout.roots.add(id);
      if (id === undefined || !FIELD_TAGS.has(tag)) return;
      const pairs = doc.nodes.attributes[i] ?? [];
      const attrs: Record<string, string> = {};
      for (let k = 0; k + 1 < pairs.length; k += 2) attrs[(snap.strings[pairs[k]!] ?? "").toLowerCase()] = snap.strings[pairs[k + 1]!] ?? "";
      layout.attrs.set(id, attrs);
    });
  });
  return layout;
}

/** Above, on, or below the window of one screen above to two screens below the scroll position. */
export function placement(layout: Layout, backendNodeId: number | undefined): "above" | "near" | "below" {
  if (backendNodeId === undefined || !layout.mainNodes.has(backendNodeId) || layout.roots.has(backendNodeId) || layout.pinned.has(backendNodeId)) return "near";
  const rect = layout.rects.get(backendNodeId);
  if (!rect) return "near";
  if (rect.y + rect.h < layout.scrollY - layout.viewHeight) return "above";
  if (rect.y > layout.scrollY + 2 * layout.viewHeight) return "below";
  return "near";
}
