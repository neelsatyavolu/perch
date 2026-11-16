import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalDocument } from "../src/agent/local-document";
import { pdfPageImage } from "../src/agent/pdf-image";
import { recentDownload } from "../src/agent/tools";
import { attachmentExtraTools, READ_ATTACHMENT } from "../src/app/sidebar-extras";

const dir = mkdtempSync(join(tmpdir(), "perch-local-doc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const pdf = join(dir, "Worksheet.pdf");
copyFileSync(join(import.meta.dir, "fixtures", "business-cycle.pdf"), pdf);
const call = (args: Record<string, unknown>) => ({ id: "c", name: READ_ATTACHMENT, args });

test.skipIf(process.platform !== "darwin")("a PDF page comes back as a JPEG the model can see", async () => {
  const shot = await pdfPageImage(pdf, 1);
  expect(shot.pages).toBeGreaterThan(0);
  expect(Buffer.from(shot.jpegBase64, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  await expect(pdfPageImage(pdf, 99)).rejects.toThrow(/page 99 can't be shown: it has \d+ page/);
});

test("an attached PDF is read as text, and page shows it as an image", async () => {
  const tools = attachmentExtraTools([{ name: "WS 1.pdf", path: pdf }])!;
  const text = await tools.run(call({ name: "WS 1.pdf" }), new AbortController().signal);
  expect(text.isError).toBeFalsy();
  expect(text.content).toContain("Expansion, peak, contraction, trough.");
  if (process.platform === "darwin") {
    const seen = await tools.run(call({ name: "WS 1.pdf", page: 1 }), new AbortController().signal);
    expect(seen).toMatchObject({ imageType: "image/jpeg" });
    expect(seen.content).toStartWith("WS 1.pdf, page 1 of");
  }
});

test.skipIf(process.platform !== "darwin")("page works for a PDF saved without .pdf in its name", async () => {
  const saved = join(dir, "download.php");
  copyFileSync(pdf, saved);
  expect(await readLocalDocument(saved, { page: 1, tool: "read_document" })).toMatchObject({ imageType: "image/jpeg" });
});

test("page only works for PDFs, and a long text says which tool reads on", async () => {
  const notes = join(dir, "notes.docx");
  writeFileSync(notes, "not really a docx");
  expect(await readLocalDocument(notes, { page: 1, tool: "read_download" })).toMatchObject({ isError: true, content: "page only works for PDFs; notes.docx isn't one." });
  expect((await readLocalDocument(notes, { tool: "read_download" })).isError).toBe(true);
});

test("read_download reads only files directly in Downloads from the last hour", () => {
  const downloads = mkdtempSync(join(dir, "dl-"));
  const fresh = join(downloads, "WS+1.pdf");
  copyFileSync(pdf, fresh);
  const now = Date.now();
  expect(recentDownload(fresh, downloads, now)).toBe(fresh);
  expect(recentDownload(`file://${fresh}`, downloads, now)).toBe(fresh);
  expect(recentDownload(join(downloads, "..", "Worksheet.pdf"), downloads, now)).toBeNull();
  expect(recentDownload(join(downloads, "missing.pdf"), downloads, now)).toBeNull();
  const old = join(downloads, "old.pdf");
  copyFileSync(pdf, old);
  utimesSync(old, new Date(now - 2 * 3_600_000), new Date(now - 2 * 3_600_000));
  expect(recentDownload(old, downloads, now)).toBeNull();
});

test("a file that is gone is a message, not a crash", async () => {
  const gone = await readLocalDocument(join(dir, "gone.pdf"), { tool: "read_attachment" });
  expect(gone.isError).toBe(true);
  expect(gone.content).toStartWith("gone.pdf couldn't be read: ENOENT");
});
