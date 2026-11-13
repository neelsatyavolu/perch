import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { documentText, fetchDocument, fileName, makeZip, part } from "../src/agent/documents";
import { handedFile } from "../src/app/handed-files";

const dir = mkdtempSync(join(tmpdir(), "perch-docs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const office = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

test("slides are read slide by slide, with speaker notes", async () => {
  const pptx = office({
    "ppt/slides/slide2.xml": '<p:sld><a:p><a:r><a:t>Trough</a:t></a:r></a:p><a:p><a:r><a:t>Lowest point &amp; turning point</a:t></a:r></a:p></p:sld>',
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Business </a:t></a:r><a:r><a:t>Cycles</a:t></a:r></a:p></p:sld>",
    "ppt/notesSlides/notesSlide1.xml": "<p:notes><a:p><a:r><a:t>Ask about 2008</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>",
  });
  expect(await documentText(pptx, "Business Cycle.pptx", "")).toBe(
    "--- Slide 1 of 2 ---\nBusiness Cycles\nSpeaker notes: Ask about 2008\n--- Slide 2 of 2 ---\nTrough\nLowest point & turning point",
  );
});

test("Word and Excel files are read as text", async () => {
  const docx = office({ "word/document.xml": "<w:document><w:p><w:r><w:t>Phase</w:t></w:r></w:p><w:p><w:r><w:t xml:space=\"preserve\">Peak: </w:t></w:r><w:r><w:t>highest output</w:t></w:r></w:p></w:document>" });
  expect(await documentText(docx, "Notes.docx", "")).toBe("Phase\nPeak: highest output");
  const xlsx = office({
    "xl/sharedStrings.xml": "<sst><si><t>Indicator</t></si><si><t>GDP</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>2024</v></c></row><row><c t="s"><v>1</v></c><c><v>3.1</v></c></row></sheetData></worksheet>',
  });
  expect(await documentText(xlsx, "Data.xlsx", "")).toBe("--- Sheet 1 of 1 ---\nIndicator\t2024\nGDP\t3.1");
});

test("PDFs, pages and unknown formats", async () => {
  const pdf = readFileSync(join(import.meta.dir, "fixtures", "business-cycle.pdf"));
  expect(await documentText(pdf, "x", "application/pdf")).toContain("Expansion, peak, contraction, trough.");
  expect(await documentText(strToU8("<html><style>x{}</style><p>Hello</p><p>World &amp; more</p></html>"), "a.html", "text/html")).toBe("Hello\nWorld & more");
  await expect(documentText(strToU8("x"), "movie.mov", "video/quicktime")).rejects.toThrow(/can't read \.mov/);
});

test("long text comes in parts that say how to read on", () => {
  const text = "a".repeat(70_000);
  expect(part(text)).toContain("Call read_document again with from=30000");
  expect(part(text, 60_000)).toBe("a".repeat(10_000));
});

test("a download gets a safe name with the right extension", () => {
  const url = new URL("https://libguides.example/ld.php?content_id=5");
  expect(fileName('attachment; filename="Roller Coaster Ride.pdf"', url, "application/pdf")).toBe("Roller Coaster Ride.pdf");
  expect(fileName("attachment; filename*=UTF-8''Business%20Cycle.pptx", url, "")).toBe("Business Cycle.pptx");
  expect(fileName(null, url, "application/pdf")).toBe("ld.php.pdf");
  expect(fileName('attachment; filename="../../etc/passwd"', url, "")).toBe("passwd");
});

test("documents download with the browser's cookies, through redirects", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(`${url.pathname} ${req.headers.get("cookie") ?? "-"}`);
      if (url.pathname === "/start") return Response.redirect("/files/notes.txt", 302);
      if (req.headers.get("cookie") !== "session=abc") return new Response("sign in", { status: 403 });
      return new Response("Lecture notes", { headers: { "content-type": "text/plain" } });
    },
  });
  try {
    const got = await fetchDocument(`http://127.0.0.1:${server.port}/start`, async (u) => (u.includes("/files/") ? "session=abc" : ""), "Perch");
    expect(new TextDecoder().decode(got.bytes)).toBe("Lecture notes");
    expect(got.name).toBe("notes.txt");
    expect(seen).toEqual(["/start -", "/files/notes.txt session=abc"]);
    await expect(fetchDocument(`http://127.0.0.1:${server.port}/files/x`, async () => "", "Perch")).rejects.toThrow(/403/);
    await expect(fetchDocument("file:///etc/passwd", async () => "", "Perch")).rejects.toThrow(/http/);
  } finally {
    server.stop();
  }
});

test("make_zip bundles the chat folder's files", () => {
  const folder = join(dir, "zip");
  mkdirSync(folder);
  writeFileSync(join(folder, "kit.md"), "# Kit");
  writeFileSync(join(folder, "slides.pptx"), "pptx");
  const all = ["kit.md", "slides.pptx"];
  const zip = makeZip(folder, "Study kit", [], all);
  expect(zip).toEqual({ path: join(folder, "Study kit.zip"), count: 2 });
  expect(Object.keys(unzipSync(readFileSync(zip.path))).sort()).toEqual(["kit.md", "slides.pptx"]);
  expect(() => makeZip(folder, "x", ["missing.pdf"], all)).toThrow(/missing\.pdf/);
});

test("only files in a chat folder can be handed to the user", () => {
  const chat = mkdtempSync(join(dir, "perch-chat-"));
  writeFileSync(join(chat, "Study kit.zip"), "zip bytes");
  const handed = handedFile(join(chat, "Study kit.zip"), dir);
  expect(handed).toEqual({ title: "Study kit.zip", mime: "application/zip", content: Buffer.from("zip bytes").toString("base64") });
  writeFileSync(join(dir, "secret.txt"), "no");
  expect(handedFile(join(dir, "secret.txt"), dir)).toEqual({ error: "only files in this chat's folder can be handed over" });
  expect(handedFile(join(chat, "..", "secret.txt"), dir)).toEqual({ error: "only files in this chat's folder can be handed over" });
  expect(handedFile(join(chat, "nope.zip"), dir)).toEqual({ error: "it doesn't exist" });
});
