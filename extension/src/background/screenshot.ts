/**
 * Full-page screenshots by scrolling and stitching visible-area captures. Fixed and sticky elements
 * show once, in the first strip, so headers do not repeat down the image. The Chromium build can
 * swap this for Page.captureScreenshot with captureBeyondViewport, which needs no scrolling.
 */

import { planTiles } from "../shot/tiles";
import { putShot } from "../shot/store";

/** Chrome allows two visible-tab captures per second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). */
const CAPTURE_GAP_MS = 520;

type Metrics = { pageHeight: number; viewportHeight: number; viewportWidth: number; dpr: number; scrollX: number; scrollY: number };

export async function fullPageScreenshot(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^(https?|file):/.test(tab.url)) throw new Error("Perch can only capture web pages.");
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });

  const metrics = await inPage(tabId, measure);
  const plan = planTiles({ pageHeight: metrics.pageHeight, viewportHeight: metrics.viewportHeight, dpr: metrics.dpr });
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let lastCapture = 0;
  try {
    for (const [index, tile] of plan.tiles.entries()) {
      if (index === 1) await inPage(tabId, hideFixed);
      const actualY = await inPage(tabId, scrollToY, [tile.y]);
      const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      lastCapture = Date.now();
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const scale = bitmap.width / metrics.viewportWidth;
      if (!canvas) {
        canvas = new OffscreenCanvas(bitmap.width, Math.round(plan.height * scale));
        ctx = canvas.getContext("2d");
      }
      const sourceY = Math.round((tile.y - actualY) * scale);
      const height = Math.min(Math.round(tile.height * scale), bitmap.height - sourceY);
      ctx!.drawImage(bitmap, 0, sourceY, bitmap.width, height, 0, Math.round(tile.y * scale), bitmap.width, height);
      bitmap.close();
    }
  } finally {
    await inPage(tabId, restore, [metrics.scrollX, metrics.scrollY]).catch(() => undefined);
  }
  const blob = await canvas!.convertToBlob({ type: "image/png" });
  const id = await putShot({ blob, title: tab.title ?? "", url: tab.url, truncated: plan.truncated, created: Date.now() });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`shot.html?id=${id}`), index: tab.index + 1, openerTabId: tabId });
  return id;
}

async function inPage<A extends unknown[], R>(tabId: number, func: (...args: A) => R | Promise<R>, args?: A): Promise<R> {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args: (args ?? []) as A });
  if (!result) throw new Error("The page could not be reached.");
  return result.result as R;
}

// The functions below run inside the page; they cannot use anything from this module.

function measure(): Metrics {
  const doc = document.documentElement;
  return {
    pageHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0, innerHeight),
    viewportHeight: innerHeight,
    viewportWidth: doc.clientWidth || innerWidth,
    dpr: devicePixelRatio,
    scrollX,
    scrollY,
  };
}

async function scrollToY(y: number): Promise<number> {
  scrollTo({ top: y, left: 0, behavior: "instant" });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 60));
  return scrollY;
}

function hideFixed(): void {
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    const position = getComputedStyle(el).position;
    if (position === "fixed" || position === "sticky") {
      el.dataset.perchShotHidden = el.style.visibility;
      el.style.setProperty("visibility", "hidden", "important");
    }
  }
}

function restore(x: number, y: number): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-perch-shot-hidden]")) {
    el.style.visibility = el.dataset.perchShotHidden ?? "";
    delete el.dataset.perchShotHidden;
  }
  scrollTo({ top: y, left: x, behavior: "instant" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
