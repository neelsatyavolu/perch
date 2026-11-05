/** Screenshots with secret fields covered, and coordinate input for pages a snapshot cannot describe. */

import type { Tab } from "../browser/tab";
import type { ActionResult } from "./actions";
import { captureLayout } from "./layout";
import { isSecretField, rememberedSecrets, secretKey } from "./secrets";

export type Screenshot = { jpegBase64: string; width: number; height: number };
type Box = { x: number; y: number; w: number; h: number };

/** Embedded payment forms (card fields in a provider's iframe): covered whole. */
const PAYMENT_FRAME = /stripe|braintree|adyen|paypal|checkout|payment|squareup|klarna|affirm|card/i;

function quadBox(q: number[], dx = 0, dy = 0): Box {
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  return { x: dx + Math.min(...xs), y: dy + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

async function boxesOf(tab: Tab, session: string | undefined, ids: number[], dx = 0, dy = 0): Promise<Box[]> {
  const all = await Promise.all(
    ids.map((backendNodeId) =>
      tab
        .sendIn<{ quads: number[][] }>(session, "DOM.getContentQuads", { backendNodeId })
        .then((r) => r.quads.map((q) => quadBox(q, dx, dy)))
        .catch(() => [] as Box[]),
    ),
  );
  return all.flat();
}

/** Secret fields inside one cross-site iframe, in page coordinates. */
async function crossSiteBoxes(tab: Tab, frameId: string, session: string, remembered: Set<string>): Promise<Box[]> {
  const owner = await tab.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId }).catch(() => null);
  if (!owner) return [];
  const { quads } = await tab.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: owner.backendNodeId }).catch(() => ({ quads: [] as number[][] }));
  const frame = quads[0] ? quadBox(quads[0]) : null;
  if (!frame) return [];
  const { root } = await tab.sendIn<{ root: { nodeId: number } }>(session, "DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await tab.sendIn<{ nodeIds: number[] }>(session, "DOM.querySelectorAll", { nodeId: root.nodeId, selector: "input" });
  const ids: number[] = [];
  for (const nodeId of nodeIds) {
    const [{ attributes }, { node }] = await Promise.all([
      tab.sendIn<{ attributes: string[] }>(session, "DOM.getAttributes", { nodeId }),
      tab.sendIn<{ node: { backendNodeId: number } }>(session, "DOM.describeNode", { nodeId }),
    ]);
    const attrs: Record<string, string> = {};
    for (let i = 0; i + 1 < attributes.length; i += 2) attrs[attributes[i]!.toLowerCase()] = attributes[i + 1]!;
    const key = secretKey(node.backendNodeId, session);
    if (isSecretField(attrs)) remembered.add(key);
    if (remembered.has(key)) ids.push(node.backendNodeId);
  }
  return boxesOf(tab, session, ids, frame.x, frame.y);
}

/**
 * Page-coordinate boxes of every secret field: in the page, its same-process iframes and shadow
 * roots (found through DOMSnapshot), in cross-site iframes (through their own sessions), plus
 * any payment iframe, covered whole.
 */
async function secretBoxes(tab: Tab): Promise<Box[]> {
  const layout = await captureLayout(tab);
  const remembered = rememberedSecrets(tab);
  const ids = new Set<number>();
  for (const key of remembered) if (key.startsWith("main:")) ids.add(Number(key.slice(5)));
  for (const [id, attrs] of layout.attrs) {
    const isFrame = "src" in attrs || "srcdoc" in attrs || attrs.title !== undefined;
    if (isSecretField(attrs)) {
      ids.add(id);
      remembered.add(secretKey(id));
    } else if (isFrame && PAYMENT_FRAME.test(`${attrs.src ?? ""} ${attrs.title ?? ""} ${attrs.name ?? ""}`)) ids.add(id);
  }
  const page = await boxesOf(tab, undefined, [...ids]);
  const frames = await Promise.all([...tab.frameSessions].map(([frameId, session]) => crossSiteBoxes(tab, frameId, session, remembered).catch(() => [] as Box[])));
  return [...page, ...frames.flat()].filter((b) => b.w > 0 && b.h > 0);
}

const cover = (boxes: Box[]) => `(() => {
  for (const b of ${JSON.stringify(boxes)}) {
    const el = document.createElement('div');
    el.setAttribute('data-perch-mask', '');
    el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#000;left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px';
    document.documentElement.appendChild(el);
  }
})()`;
const UNCOVER = "document.querySelectorAll('[data-perch-mask]').forEach((el) => el.remove())";

export async function screenshot(tab: Tab, opts: { maxWidth?: number; quality?: number } = {}): Promise<Screenshot> {
  const { cssVisualViewport: view } = await tab.send<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>(
    "Page.getLayoutMetrics",
  );
  const scale = opts.maxWidth && view.clientWidth > opts.maxWidth ? opts.maxWidth / view.clientWidth : 1;
  const boxes = await secretBoxes(tab);
  if (boxes.length) await tab.evaluate(cover(boxes));
  try {
    const { data } = await tab.send<{ data: string }>("Page.captureScreenshot", {
      format: "jpeg",
      quality: opts.quality ?? 70,
      // The clip is in page coordinates: start at the scroll position, not the top of the page.
      clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale },
    });
    return { jpegBase64: data, width: Math.round(view.clientWidth * scale), height: Math.round(view.clientHeight * scale) };
  } finally {
    if (boxes.length) await tab.evaluate(UNCOVER).catch(() => undefined);
  }
}

export async function clickAt(tab: Tab, x: number, y: number): Promise<ActionResult> {
  try {
    for (const [type, extra] of [
      ["mouseMoved", {}],
      ["mousePressed", { button: "left", buttons: 1, clickCount: 1 }],
      ["mouseReleased", { button: "left", buttons: 0, clickCount: 1 }],
    ] as const) {
      await tab.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
    }
    return { ok: true, note: `clicked at ${Math.round(x)}, ${Math.round(y)}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function typeText(tab: Tab, text: string): Promise<ActionResult> {
  try {
    await tab.send("Input.insertText", { text });
    return { ok: true, note: `typed ${text.length} characters` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
