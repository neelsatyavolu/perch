/**
 * One page of a PDF as a JPEG the model can look at, for scans and handwriting that have no text
 * layer. macOS draws it with PDFKit through osascript, so Perch ships no PDF renderer of its own.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The longer side of the image, in pixels: enough to read handwriting, small enough to send. */
const MAX_SIDE = 1600;
const TIMEOUT_MS = 30_000;

// argv: path, page (1-based), output file, longer side. Prints "pages" or "error: …".
const RENDER_JS = `ObjC.import('PDFKit'); ObjC.import('AppKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return "error: not a PDF macOS can open";
  const count = doc.pageCount, index = Number(argv[1]) - 1;
  if (!(index >= 0 && index < count)) return "error: it has " + count + " page" + (count === 1 ? "" : "s");
  const page = doc.pageAtIndex(index), box = page.boundsForBox(0).size;
  const scale = Math.min(Number(argv[3]) / box.width, Number(argv[3]) / box.height);
  const image = page.thumbnailOfSizeForBox($.NSMakeSize(Math.round(box.width * scale), Math.round(box.height * scale)), 0);
  const jpeg = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation).representationUsingTypeProperties(3, $({ NSImageCompressionFactor: 0.8 }));
  if (!jpeg.writeToFileAtomically(argv[2], true)) return "error: the image could not be written";
  return String(count);
}`;

export type PageImage = { jpegBase64: string; pages: number };

/** Page `page` (1-based) of the PDF at `path`; throws with a reason the agent can act on. */
export async function pdfPageImage(path: string, page: number): Promise<PageImage> {
  if (process.platform !== "darwin") throw new Error("seeing PDF pages needs macOS");
  const dir = mkdtempSync(join(tmpdir(), "perch-page-"));
  const out = join(dir, "page.jpg");
  try {
    const child = Bun.spawn(["osascript", "-l", "JavaScript", "-e", RENDER_JS, path, String(page), out, String(MAX_SIDE)], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const [said, failed, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    const answer = said.trim();
    if (answer.startsWith("error: ")) throw new Error(`page ${page} can't be shown: ${answer.slice(7)}`);
    if (code !== 0 || !/^\d+$/.test(answer)) throw new Error(`page ${page} could not be drawn${failed.trim() ? ` (${failed.trim().split("\n")[0]})` : ""}`);
    return { jpegBase64: readFileSync(out).toString("base64"), pages: Number(answer) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
