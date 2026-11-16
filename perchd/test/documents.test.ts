import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { cachedDocument, cacheDocument, documentText, fetchDocument, fileName, makeZip, part, privateAddress } from "../src/agent/documents";
import { newToolContext } from "../src/agent/tools";
import type { Browser } from "../src/browser/browser";
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

test("Excel keeps each cell in its column, skips empty styled cells cleanly and names the sheets", async () => {
  const xlsx = office({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Summary" sheetId="2" r:id="rId2"/><sheet name="Q1 &amp; Q2" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    "xl/sharedStrings.xml": '<sst><si><r><t>Total</t></r><r><t xml:space="preserve"> due</t></r></si></sst>',
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" s="1"/><c r="B1" t="s"><v>0</v></c><c r="D1"><v>4</v></c></row><row r="2" spans="1:4"/><row r="3"><c r="A3" t="inlineStr"><is><t>Paid</t></is></c><c r="B3" t="b"><v>1</v></c><c r="C3"><f>SUM(A1:A2)</f><v>7</v></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
  });
  expect(await documentText(xlsx, "Budget.xlsx", "")).toBe("--- Sheet 1 of 2: Summary ---\n1\n--- Sheet 2 of 2: Q1 & Q2 ---\n\tTotal due\t\t4\nPaid\tTRUE\t7");
});

test("Word keeps tabs and line breaks between words, and table rows on one line", async () => {
  const docx = office({
    "word/document.xml":
      '<w:document><w:body><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Name:</w:t><w:tab/><w:t>Maya</w:t><w:br/><w:t>Room 4</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:trPr/><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>Bus</w:t></w:r></w:p><w:p><w:r><w:t>pass</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$5 &amp; up</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  });
  expect(await documentText(docx, "Form.docx", "")).toBe("Name:\tMaya\nRoom 4\nItem | Cost\nBus pass | $5 & up");
});

test("web pages decode named and numbered entities, drop comments and keep table cells apart", async () => {
  const html = "<html><!-- <p>hidden</p> --><body><p>Caf&#233;&nbsp;&mdash; it&#x27;s &ldquo;open&rdquo; &amp;nbsp;</p><table><tr><th>Day</th><th>Hours</th></tr><tr><td>Mon</td><td>9&ndash;5</td></tr></table></body></html>";
  expect(await documentText(strToU8(html), "a.html", "text/html")).toBe("Café — it's “open” &nbsp;\nDay | Hours\nMon | 9–5");
});

test("text in other encodings and formats without a known extension is still read", async () => {
  // Excel's "Unicode text" export: UTF-16 with a byte order mark.
  const utf16 = new Uint8Array([0xff, 0xfe, ...[..."a\tb"].flatMap((c) => [c.charCodeAt(0), 0])]);
  expect(await documentText(utf16, "export.txt", "")).toBe("a\tb");
  // A Windows CSV with a curly quote and an accent (Windows-1252, not UTF-8).
  expect(await documentText(new Uint8Array([0x93, 0x43, 0x61, 0x66, 0xe9, 0x94]), "list.csv", "")).toBe("“Café”");
  expect(await documentText(strToU8("level: 3\nname: x"), "config.yaml", "")).toBe("level: 3\nname: x");
  expect(await documentText(strToU8("2026-11-16 ok"), "server.log", "application/octet-stream")).toBe("2026-11-16 ok");
  await expect(documentText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), "picture", "application/octet-stream")).rejects.toThrow(/can't read this kind of/);
});

test("a file with no extension is read by what it contains", async () => {
  const pdf = readFileSync(join(import.meta.dir, "fixtures", "business-cycle.pdf"));
  expect(await documentText(pdf, "download.php", "application/octet-stream")).toContain("Expansion, peak, contraction, trough.");
  const docx = office({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document><w:p><w:r><w:t>Essay</w:t></w:r></w:p></w:document>" });
  expect(await documentText(docx, "file", "application/octet-stream")).toBe("Essay");
});

test("unreadable files say why and what to do", async () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  await expect(documentText(ole, "old.doc", "application/msword")).rejects.toThrow(/older \.doc format.*\.docx/);
  // Many sites' "Export to Excel" sends a web page or CSV named .xls; those are read.
  expect(await documentText(strToU8("<html xmlns:x=\"urn:schemas-microsoft-com:office:excel\"><body><table><tr><td>Item</td><td>Price</td></tr></table></body></html>"), "report.xls", "application/vnd.ms-excel")).toBe("Item | Price");
  expect(await documentText(strToU8("Item,Price\nTea,2"), "report.xls", "application/vnd.ms-excel")).toBe("Item,Price\nTea,2");
  const signIn = strToU8("<!doctype html><html><title>Sign in</title><style>p{width:100%}</style><form>Password</form></html>");
  await expect(documentText(signIn, "notes.pdf", "application/octet-stream")).rejects.toThrow(/sent a web page, not the file/);
});

test("reading past the end says the text has ended", () => {
  expect(part("short", 500)).toBe("(The text ends at character 5; there is no more.)");
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

/** A fake web: each address answers from `pages`; every request is recorded with its cookie. */
function fakeWeb(pages: Record<string, () => Response>) {
  const seen: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const cookie = (init.headers as Record<string, string>).cookie ?? "-";
    seen.push(`${url} ${cookie}`);
    const page = pages[url];
    if (!page) return new Response("not found", { status: 404 });
    return page();
  };
  return { seen, fetch };
}
const publicDns = async () => ["93.184.215.14"];
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

test("documents download with the browser's cookies, through redirects", async () => {
  const web = fakeWeb({
    "https://lms.example/start": redirect("/files/notes.txt"),
    "https://lms.example/files/notes.txt": () => new Response("Lecture notes", { headers: { "content-type": "text/plain" } }),
  });
  const got = await fetchDocument("https://lms.example/start", async (u) => (u.includes("/files/") ? "session=abc" : ""), "Perch", { fetch: web.fetch, resolve: publicDns });
  expect(new TextDecoder().decode(got.bytes)).toBe("Lecture notes");
  expect(got.name).toBe("notes.txt");
  expect(web.seen).toEqual(["https://lms.example/start -", "https://lms.example/files/notes.txt session=abc"]);
  await expect(fetchDocument("https://lms.example/files/x", async () => "", "Perch", { fetch: web.fetch, resolve: publicDns })).rejects.toThrow(/404/);
  await expect(fetchDocument("file:///etc/passwd", async () => "", "Perch")).rejects.toThrow(/http/);
});

test("a server that never sends the file gives up with a plain error instead of holding the agent", async () => {
  const hang = async (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  await expect(fetchDocument("https://slow.example/x.pdf", async () => "", "Perch", { fetch: hang, resolve: publicDns, timeoutMs: 50 })).rejects.toThrow(
    /the server did not send the file within/,
  );
});

test("cookies never go over plain http, even after a redirect from https", async () => {
  const web = fakeWeb({
    "https://lms.example/start": redirect("http://lms.example/plain.txt"),
    "http://lms.example/plain.txt": () => new Response("ok", { headers: { "content-type": "text/plain" } }),
  });
  await fetchDocument("https://lms.example/start", async () => "session=abc", "Perch", { fetch: web.fetch, resolve: publicDns });
  expect(web.seen).toEqual(["https://lms.example/start session=abc", "http://lms.example/plain.txt -"]);
});

test("read_document refuses this Mac and the local network, at every hop and by every resolved address", async () => {
  const web = fakeWeb({ "https://lms.example/start": redirect("http://169.254.169.254/latest/meta-data") });
  const opts = { fetch: web.fetch, resolve: publicDns };
  for (const url of ["http://127.0.0.1:8080/x", "http://localhost/x", "http://printer.local/x", "https://wiki.corp.internal/x", "http://10.0.0.5/x", "http://[::1]/x", "http://[::ffff:127.0.0.1]/x", "http://2130706433/x"]) {
    await expect(fetchDocument(url, async () => "", "Perch", opts)).rejects.toThrow(/local network/);
  }
  await expect(fetchDocument("https://lms.example/start", async () => "", "Perch", opts)).rejects.toThrow(/local network/);
  expect(web.seen).toEqual(["https://lms.example/start -"]);
  // A public-looking name that resolves to a private address (DNS rebinding) is refused too.
  const rebinding = async () => ["93.184.215.14", "192.168.1.1"];
  await expect(fetchDocument("https://evil.example/x", async () => "", "Perch", { fetch: web.fetch, resolve: rebinding })).rejects.toThrow(/local network/);
  expect(web.seen).toHaveLength(1);
});

test("privateAddress covers loopback, private, link-local and unique-local ranges", () => {
  for (const ip of ["127.0.0.1", "127.9.9.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "::ffff:10.0.0.1"]) {
    expect(privateAddress(ip)).toBe(true);
  }
  for (const ip of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111", "fec0::1"]) expect(privateAddress(ip)).toBe(false);
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

test("closing a chat's tools forgets the documents it read, and only its own", async () => {
  const ctx = await newToolContext({} as Browser);
  const other = await newToolContext({} as Browser);
  cacheDocument(ctx.workDir, "https://lms.example/a.pdf", { path: `${ctx.workDir}/a.pdf`, text: "secret notes" });
  cacheDocument(other.workDir, "https://lms.example/a.pdf", { path: `${other.workDir}/a.pdf`, text: "other notes" });
  await ctx.close();
  expect(cachedDocument(ctx.workDir, "https://lms.example/a.pdf")).toBeUndefined();
  expect(cachedDocument(other.workDir, "https://lms.example/a.pdf")?.text).toBe("other notes");
  await other.close();
});
