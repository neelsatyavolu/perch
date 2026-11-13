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
