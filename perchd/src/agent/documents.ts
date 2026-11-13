/**
 * Documents behind links (PDFs, slides, Word and Excel files, plain text): read_document downloads
 * one with the browser's own cookies, so files on sites the user is signed in to work, keeps the
 * original in the chat's folder and returns its text. make_zip bundles files from that folder.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { textOf as pdfText } from "../page/pdf";

const MAX_BYTES = 50_000_000;
const MAX_HOPS = 8;
/** Text returned per call; `from` reads on. */
export const PART_CHARS = 30_000;

export type Fetched = { bytes: Uint8Array; type: string; name: string; url: string };

export type CookieSource = (url: string) => Promise<string>;

/** Downloads `url`, following redirects, sending the browser's cookies for each address it passes. */
export async function fetchDocument(url: string, cookies: CookieSource, userAgent: string): Promise<Fetched> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") throw new Error("only http and https addresses can be read");
    const cookie = await cookies(current.href).catch(() => "");
    const res = await fetch(current.href, { redirect: "manual", headers: { "user-agent": userAgent, accept: "*/*", ...(cookie ? { cookie } : {}) } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > MAX_BYTES) throw new Error(`the file is ${Math.round(size / 1e6)} MB, more than ${MAX_BYTES / 1e6} MB`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error(`the file is more than ${MAX_BYTES / 1e6} MB`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    return { bytes, type, name: fileName(res.headers.get("content-disposition"), current, type), url: current.href };
  }
  throw new Error("too many redirects");
}

const TYPE_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/html": ".html",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/json": ".json",
};

/** A safe file name: the server's, else the address's last part, with an extension for its type. */
export function fileName(disposition: string | null, url: URL, type: string): string {
  const star = disposition?.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  let name = "";
  try {
    name = star ? decodeURIComponent(star.trim().replace(/^"|"$/g, "")) : plain?.trim() ?? decodeURIComponent(basename(url.pathname));
  } catch {
    name = basename(url.pathname);
  }
  // A server's name keeps only its last part, so "../../x" is just "x".
  name = basename(name.replace(/\\/g, "/"));
  name = name.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120) || "document";
  const wanted = TYPE_EXT[type];
  return wanted && extname(name).toLowerCase() !== wanted ? `${name}${wanted}` : name;
}

/** A path in `dir` for `name` that doesn't overwrite another file. */
export function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? name : `${stem} ${n}${ext}`);
    if (!existsSync(path)) return path;
  }
}

/** The document's text, by its type or extension. Throws when the format is not one Perch reads. */
export async function documentText(bytes: Uint8Array, name: string, type: string): Promise<string> {
  const ext = extname(name).toLowerCase();
  if (type === "application/pdf" || ext === ".pdf") {
    const pdf = await pdfText(bytes);
    if ("error" in pdf) throw new Error(pdf.error);
    return pdf.pages.map((p, i) => `--- Page ${i + 1} of ${pdf.pages.length} ---\n${p || "(no text on this page; it may be a scanned image)"}`).join("\n");
  }
  if (ext === ".pptx" || ext === ".docx" || ext === ".xlsx") return officeText(bytes, ext);
  if (type === "text/html" || ext === ".html" || ext === ".htm") return htmlText(strFromU8(bytes));
  if (type.startsWith("text/") || type === "application/json" || [".txt", ".csv", ".json", ".md"].includes(ext)) return strFromU8(bytes);
  throw new Error(`Perch can't read ${ext || type || "this kind of"} files; it reads PDF, PowerPoint, Word, Excel, web pages and plain text`);
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

/** Text runs (`<a:t>`, `<w:t>`, `<t>`) of each paragraph, a line per paragraph. */
function paragraphs(xml: string, para: string, run: string): string {
  return xml
    .split(new RegExp(`</${para}>`))
    .map((p) => [...p.matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, "g"))].map((m) => decodeXml(m[1]!)).join(""))
    .filter((line) => line.trim())
    .join("\n");
}

const numbered = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

function officeText(bytes: Uint8Array, ext: string): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name.endsWith(".xml") });
  } catch {
    throw new Error(`the ${ext} file could not be opened`);
  }
  const xml = (name: string) => (files[name] ? strFromU8(files[name]) : "");
  if (ext === ".docx") return paragraphs(xml("word/document.xml"), "w:p", "w:t");
  if (ext === ".pptx") {
    const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => numbered(a) - numbered(b));
    return slides
      .map((s, i) => {
        const notes = paragraphs(xml(`ppt/notesSlides/notesSlide${numbered(s)}.xml`), "a:p", "a:t").replace(/^\d+$/m, "").trim();
        return `--- Slide ${i + 1} of ${slides.length} ---\n${paragraphs(xml(s), "a:p", "a:t") || "(no text on this slide)"}${notes ? `\nSpeaker notes: ${notes}` : ""}`;
      })
      .join("\n");
  }
  // .xlsx: each sheet's rows, cells separated by tabs, shared strings looked up.
  const shared = [...xml("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1]!)).join(""));
  const sheets = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => numbered(a) - numbered(b));
  return sheets
    .map((s, i) => {
      const rows = [...xml(s).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1]!.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)]
          .map((c) => {
            const value = c[2]!.match(/<v>([^<]*)<\/v>/)?.[1] ?? c[2]!.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/)?.[1] ?? "";
            return /t="s"/.test(c[1]!) ? shared[Number(value)] ?? "" : decodeXml(value);
          })
          .join("\t"),
      );
      return `--- Sheet ${i + 1} of ${sheets.length} ---\n${rows.join("\n")}`;
    })
    .join("\n");
}

function htmlText(html: string): string {
  return decodeXml(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h\d|tr|br)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

/** Part of a long text, from character `from`, with a note on what is left. */
export function part(text: string, from = 0): string {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.min(text.length, start + PART_CHARS);
  const rest = end < text.length ? `\n\n(Characters ${start}–${end} of ${text.length}. Call read_document again with from=${end} for more.)` : "";
  return `${text.slice(start, end)}${rest}`;
}

/** Zips files from `dir` (all of them when `names` is empty) into `dir/<name>.zip`. */
export function makeZip(dir: string, name: string, names: string[], all: string[]): { path: string; count: number } {
  const picked = names.length ? names.map((n) => basename(n)) : all.filter((n) => !n.endsWith(".zip"));
  const missing = picked.filter((n) => !all.includes(n));
  if (missing.length) throw new Error(`not in this chat's folder: ${missing.join(", ")}`);
  if (!picked.length) throw new Error("this chat's folder has no files yet; save some with write_file or read_document first");
  const zipName = `${basename(name).replace(/\.zip$/i, "").replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ").trim() || "files"}.zip`;
  const path = freeName(dir, zipName);
  const entries = Object.fromEntries(picked.map((n) => [n, readFileSync(join(dir, n))]));
  writeFileSync(path, zipSync(entries, { level: 6 }));
  return { path, count: picked.length };
}
