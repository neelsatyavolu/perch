import { expect, test } from "bun:test";
import { join } from "node:path";
import { pdfSection, textOf } from "../src/page/pdf";

const fixture = join(import.meta.dir, "fixtures", "business-cycle.pdf");

test("a PDF's text is read page by page", async () => {
  const result = await textOf(new Uint8Array(await Bun.file(fixture).arrayBuffer()));
  expect(result).toEqual({ pages: ["Business Cycle Notes\nExpansion, peak, contraction, trough."] });
});

test("the snapshot shows the text, and says when pages are left out", () => {
  expect(pdfSection({ pages: ["One"] }, false)).toBe("\nThis is a PDF (1 page). Its text:\n--- Page 1 of 1 ---\nOne");
  const long = pdfSection({ pages: ["a".repeat(15_000), "b".repeat(15_000)] }, false);
  expect(long).toContain("showing 1");
  expect(long).toContain("Pages 2–2 not shown (take a full snapshot to see more)");
  expect(pdfSection({ pages: ["a".repeat(15_000), "b".repeat(15_000)] }, true)).toContain("--- Page 2 of 2 ---");
  expect(pdfSection({ pages: [""] }, false)).toContain("may be a scanned image");
});

test("a PDF too long for a full snapshot says how to read the rest, and a scanned page how to see it", () => {
  const long = pdfSection({ pages: Array.from({ length: 10 }, () => "a".repeat(15_000)) }, true);
  expect(long).toContain("--- Pages 8–10 not shown: read_document with this page's address reads them, a part at a time ---");
  expect(pdfSection({ pages: ["", "Text"] }, false)).toContain("--- Page 1 of 2 ---\n(no text on this page; it may be a scanned image. read_document with this page's address and page=1 shows it as an image)");
});

test("a file that is not a PDF says so instead of failing the step", async () => {
  const result = await textOf(new TextEncoder().encode("not a pdf"));
  expect("error" in result && result.error).toContain("could not be read");
});
