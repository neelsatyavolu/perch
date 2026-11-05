/** Screenshots with secret fields covered, and coordinate input for pages a snapshot cannot describe. */

import type { Tab } from "../browser/tab";
import type { ActionResult } from "./actions";
import { IS_SECRET_JS } from "./secrets";

export type Screenshot = { jpegBase64: string; width: number; height: number };

const COVER = `(() => {
  const isSecret = ${IS_SECRET_JS};
  let covered = 0;
  for (const el of document.querySelectorAll('input')) {
    if (!isSecret(el) || !el.value) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const box = document.createElement('div');
    box.setAttribute('data-perch-mask', '');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#000;' +
      'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    document.documentElement.appendChild(box);
    covered++;
  }
  return covered;
})()`;
const UNCOVER = "document.querySelectorAll('[data-perch-mask]').forEach((el) => el.remove())";

export async function screenshot(tab: Tab, opts: { maxWidth?: number; quality?: number } = {}): Promise<Screenshot> {
  const [width, height] = await tab.evaluate<[number, number]>("[innerWidth, innerHeight]");
  const scale = opts.maxWidth && width > opts.maxWidth ? opts.maxWidth / width : 1;
  await tab.evaluate(COVER);
  try {
    const { data } = await tab.send<{ data: string }>("Page.captureScreenshot", {
      format: "jpeg",
      quality: opts.quality ?? 70,
      clip: { x: 0, y: 0, width, height, scale },
    });
    return { jpegBase64: data, width: Math.round(width * scale), height: Math.round(height * scale) };
  } finally {
    await tab.evaluate(UNCOVER).catch(() => undefined);
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
