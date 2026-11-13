/**
 * PDFs in the browser's viewer: the page's accessibility tree holds only the viewer's toolbar, so
 * the agent reads the document's text instead. The file is fetched from inside the page (with the
 * page's own cookies, so signed-in PDFs work) and its text extracted with pdf.js (unpdf).
 */

import { extractText, getDocumentProxy } from "unpdf";
import type { Tab } from "../browser/tab";

/** Larger files are not read; the agent is told to download them instead. */
const MAX_BYTES = 25_000_000;
/** Text shown with each snapshot; a full snapshot shows up to FULL_CHARS. */
const SHOWN_CHARS = 20_000;
const FULL_CHARS = 120_000;

const FETCH_JS = `(async () => {
  if (document.contentType !== "application/pdf") return null;
  const res = await fetch(location.href, { credentials: "include" });
  if (!res.ok) return { error: "the server answered " + res.status };
  const blob = await res.blob();
  if (blob.size > ${MAX_BYTES}) return { error: "the file is " + Math.round(blob.size / 1e6) + " MB, too large to read here" };
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { data };
})()`;

type Fetched = { data: string } | { error: string } | null;

export type PdfPages = { pages: string[] } | { error: string };

/** Each page's text, joined lines kept; read once per address and tab. */
const cache = new WeakMap<Tab, { url: string; result: Promise<PdfPages | null> }>();

export function pdfPages(tab: Tab, url: string): Promise<PdfPages | null> {
  const hit = cache.get(tab);
  if (hit && hit.url === url) return hit.result;
  const result = read(tab);
  cache.set(tab, { url, result });
  return result;
}

async function read(tab: Tab): Promise<PdfPages | null> {
  const fetched = await tab.evaluate<Fetched>(FETCH_JS).catch((e: Error) => ({ error: e.message }));
  if (!fetched) return null;
  if ("error" in fetched) return { error: fetched.error };
  return textOf(Buffer.from(fetched.data, "base64"));
}

export async function textOf(bytes: Uint8Array): Promise<PdfPages> {
  try {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(doc, { mergePages: false });
    return { pages: (Array.isArray(text) ? text : [text]).map((t) => t.replace(/[ \t]+/g, " ").trim()) };
  } catch (e) {
    return { error: `the PDF could not be read (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** The text block added to a snapshot of a PDF. */
export function pdfSection(result: PdfPages, full: boolean): string {
  if ("error" in result) return `\nThis is a PDF, but its text could not be read: ${result.error}. Download it (the viewer's Download button) if you need it.`;
  const limit = full ? FULL_CHARS : SHOWN_CHARS;
  const total = result.pages.length;
  let out = "";
  let shown = 0;
  for (const [i, page] of result.pages.entries()) {
    const block = `\n--- Page ${i + 1} of ${total} ---\n${page || "(no text on this page; it may be a scanned image)"}`;
    if (out.length + block.length > limit) {
      out += `\n--- Pages ${i + 1}–${total} not shown (${full ? "too long" : "take a full snapshot to see more"}) ---`;
      break;
    }
    out += block;
    shown = i + 1;
  }
  return `\nThis is a PDF (${total} page${total === 1 ? "" : "s"}${shown < total ? `, showing ${shown}` : ""}). Its text:${out}`;
}
