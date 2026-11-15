/**
 * Reads a document already on the Mac (an attachment, a download, a file read_document saved):
 * its text, a part at a time, or with `page` one PDF page as an image, for scans and handwriting.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { documentText, part } from "./documents";
import { pdfPageImage } from "./pdf-image";

/** Larger files are not read, as with PDFs in the browser's viewer. */
const MAX_BYTES = 25_000_000;

export type LocalRead = { content: string; image?: string; imageType?: string; isError?: boolean };
export type ReadOptions = { from?: number; page?: number; tool: string; title?: string };

export const isPdf = (path: string) => extname(path).toLowerCase() === ".pdf";

/** A page as an image the model sees. Only PDFs have pages. */
export async function pageOf(path: string, page: number, title = basename(path)): Promise<LocalRead> {
  if (!isPdf(path)) return { content: `page only works for PDFs; ${title} isn't one.`, isError: true };
  try {
    const shot = await pdfPageImage(path, page);
    return { content: `${title}, page ${page} of ${shot.pages}`, image: shot.jpegBase64, imageType: "image/jpeg" };
  } catch (e) {
    return { content: `${title}: ${e instanceof Error ? e.message : String(e)}.`, isError: true };
  }
}

export async function readLocalDocument(path: string, opts: ReadOptions): Promise<LocalRead> {
  const title = opts.title ?? basename(path);
  if (opts.page !== undefined) return pageOf(path, opts.page, title);
  try {
    const size = (await stat(path)).size;
    if (size > MAX_BYTES) return { content: `${title} is ${Math.round(size / 1e6)} MB, too large to read.`, isError: true };
    const text = await documentText(await readFile(path), path, "");
    return { content: `${title}:\n\n${part(text, opts.from ?? 0, opts.tool)}` };
  } catch (e) {
    return { content: `${title} couldn't be read: ${e instanceof Error ? e.message : String(e)}.`, isError: true };
  }
}
