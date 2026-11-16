/**
 * Documents behind links (PDFs, slides, Word and Excel files, plain text): read_document downloads
 * one with the browser's own cookies, so files on sites the user is signed in to work, keeps the
 * original in the chat's folder and returns its text. make_zip bundles files from that folder.
 */

import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, extname, join } from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { textOf as pdfText } from "../page/pdf";

const MAX_BYTES = 50_000_000;
const MAX_HOPS = 8;
/** The most one download may take, redirects and all: a server that never answers must not hold the agent. */
const DOWNLOAD_MS = 120_000;
/** Text returned per call; `from` reads on. */
export const PART_CHARS = 30_000;

export type Fetched = { bytes: Uint8Array; type: string; name: string; url: string };

export type CookieSource = (url: string) => Promise<string>;
/** Every address a host name resolves to. */
export type Resolver = (host: string) => Promise<string[]>;
export type FetchOptions = { resolve?: Resolver; fetch?: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number };

const resolveAll: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Downloads `url`, following redirects. The browser's cookies go with each https address it
 * passes, never with plain http, where anyone on the network could read them. Every hop must be a
 * public host (publicHost), so a page cannot point the agent at the Mac itself or the local network.
 */
export async function fetchDocument(url: string, cookies: CookieSource, userAgent: string, opts: FetchOptions = {}): Promise<Fetched> {
  const get = opts.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_MS);
  try {
    return await download(new URL(url), cookies, userAgent, get, opts.resolve ?? resolveAll, signal);
  } catch (error) {
    if (signal.aborted) throw new Error(`the server did not send the file within ${Math.round((opts.timeoutMs ?? DOWNLOAD_MS) / 1000)} s`);
    throw error;
  }
}

async function download(current: URL, cookies: CookieSource, userAgent: string, get: NonNullable<FetchOptions["fetch"]>, resolve: Resolver, signal: AbortSignal): Promise<Fetched> {
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") throw new Error("only http and https addresses can be read");
    await publicHost(current, resolve);
    const cookie = current.protocol === "https:" ? await cookies(current.href).catch(() => "") : "";
    const res = await get(current.href, { redirect: "manual", signal, headers: { "user-agent": userAgent, accept: "*/*", ...(cookie ? { cookie } : {}) } });
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

const LOCAL_NAME = /(^|\.)(localhost|local|internal)$/i;

/**
 * Throws unless the host is public. A name is checked by every address it resolves to, so a
 * public-looking name that points at 127.0.0.1 or the local network is refused too. (fetch looks
 * the name up again, so a server that changes its answer within that moment is not caught.)
 */
export async function publicHost(url: URL, resolve: Resolver): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const refuse = () => new Error(`${host} is on this Mac or the local network; read_document only reads public addresses`);
  if (!host || LOCAL_NAME.test(host)) throw refuse();
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => {
    throw new Error(`${host} could not be found`);
  });
  if (!addresses.length || addresses.some(privateAddress)) throw refuse();
}

/** Loopback, private, link-local and unspecified addresses, IPv4 and IPv6. */
export function privateAddress(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return privateAddress(mapped);
  // URLs write an IPv4-mapped address in hex ([::ffff:7f00:1] for 127.0.0.1).
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    const first = parseInt(v6.split(":")[0] || "0", 16);
    // fc00::/7 (unique local) and fe80::/10 (link-local).
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return true;
}

export type ReadDocument = { path: string; text: string | Error };

/** Documents read in each chat folder, by address, so reading on does not download again. */
const cache = new Map<string, ReadDocument>();

export function cachedDocument(workDir: string, url: string): ReadDocument | undefined {
  return cache.get(`${workDir}\n${url}`);
}

export function cacheDocument(workDir: string, url: string, doc: ReadDocument): void {
  cache.set(`${workDir}\n${url}`, doc);
}

/** Drops a closed chat folder's documents, so their text does not stay in memory after the chat. */
export function forgetDocuments(workDir: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${workDir}\n`)) cache.delete(key);
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

const TEXT_EXT = new Set([".txt", ".csv", ".tsv", ".json", ".md", ".markdown", ".xml", ".yaml", ".yml", ".log", ".ics", ".vcf"]);
const OLD_OFFICE: Record<string, string> = { ".doc": ".docx", ".xls": ".xlsx", ".ppt": ".pptx" };
const OFFICE_PART: [string, string][] = [["word/document.xml", ".docx"], ["ppt/presentation.xml", ".pptx"], ["xl/workbook.xml", ".xlsx"]];

const startsWith = (bytes: Uint8Array, text: string) => [...text].every((c, i) => bytes[i] === c.charCodeAt(0));
const looksLikeHtml = (bytes: Uint8Array) => /^\s*(<!--[\s\S]*?-->\s*)*<(!doctype html|html|head|body)[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 1024)));

/** An Office file's extension by the parts inside the zip, for files saved without one. */
function officeKind(bytes: Uint8Array): string | undefined {
  const names: string[] = [];
  try {
    unzipSync(bytes, { filter: (f) => (names.push(f.name), false) });
  } catch {
    return undefined;
  }
  return OFFICE_PART.find(([part]) => names.includes(part))?.[1];
}

/** Plain text when the bytes are text: a UTF-16 byte order mark, or valid UTF-8 with no NUL bytes. */
function sniffText(bytes: Uint8Array): string | undefined {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return decodeText(bytes);
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Text in the encoding it was written in: UTF-16 by its byte order mark, a web page's own
 * `<meta charset>`, UTF-8, and otherwise Windows-1252, which older Windows CSV and text files use.
 */
export function decodeText(bytes: Uint8Array, html = false): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const declared = html ? new TextDecoder().decode(bytes.subarray(0, 2048)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] : undefined;
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // A charset this runtime doesn't know: fall through to UTF-8.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * The document's text, by its type or extension, or for a file saved without either (a link to
 * download.php, an attachment called "file") by what its bytes are. Throws when Perch can't read it.
 */
export async function documentText(bytes: Uint8Array, name: string, type: string): Promise<string> {
  let ext = extname(name).toLowerCase();
  if (type === "application/pdf" || ext === ".pdf" || startsWith(bytes, "%PDF-")) {
    // A PDF's header may come after up to 1 KB of other bytes; a page with none is not the file.
    if (!new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-") && looksLikeHtml(bytes)) {
      throw new Error("the server sent a web page, not the file (often a sign-in or cookie page); open the link in a tab to see it");
    }
    const pdf = await pdfText(bytes);
    if ("error" in pdf) throw new Error(pdf.error);
    return pdf.pages.map((p, i) => `--- Page ${i + 1} of ${pdf.pages.length} ---\n${p || `(no text on this page; it may be a scan or handwriting. Read it again with page=${i + 1} to see it as an image)`}`).join("\n");
  }
  if (![".pptx", ".docx", ".xlsx"].includes(ext) && startsWith(bytes, "PK\x03\x04")) ext = officeKind(bytes) ?? ext;
  if (ext === ".pptx" || ext === ".docx" || ext === ".xlsx") return officeText(bytes, ext);
  if (type === "text/html" || ext === ".html" || ext === ".htm" || looksLikeHtml(bytes)) return htmlText(decodeText(bytes, true));
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXT.has(ext)) return decodeText(bytes);
  // A server's type for pictures, sound and video is trusted; a vague one (octet-stream, none) is not.
  const text = /^(image|audio|video|font)\//.test(type) ? undefined : sniffText(bytes);
  if (text !== undefined) return text;
  // Checked last: a site's "Export to Excel" often sends a web page or CSV named .xls, and that reads fine.
  if (OLD_OFFICE[ext]) throw new Error(`it is in the older ${ext} format, which Perch can't read; it reads ${OLD_OFFICE[ext]}`);
  throw new Error(`Perch can't read ${ext || "this kind of"} files; it reads PDF, PowerPoint, Word, Excel, web pages and text files`);
}

const ENTITIES: Record<string, string> = {
  nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•", middot: "·",
  copy: "©", reg: "®", trade: "™", deg: "°", times: "×", euro: "€", pound: "£", laquo: "«", raquo: "»",
};

const codePoint = (n: number, whole: string) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole);

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (whole, n: string) => codePoint(Number(n), whole))
    .replace(/&#x([0-9a-f]+);/gi, (whole, n: string) => codePoint(parseInt(n, 16), whole))
    .replace(/&amp;/g, "&");

/** The raw (still escaped) text of each run (`<a:t>`, `<w:t>`, `<t>`) in a piece of XML, joined. */
const runsOf = (xml: string, run: string) => [...xml.matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, "g"))].map((m) => m[1]!).join("");

/** Text runs of each paragraph, a line per paragraph. */
function paragraphs(xml: string, para: string, run: string): string {
  return xml
    .split(new RegExp(`</${para}>`))
    .map((p) => decodeXml(runsOf(p, run)))
    .filter((line) => line.trim())
    .join("\n");
}

const numbered = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

function officeText(bytes: Uint8Array, ext: string): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name.endsWith(".xml") || f.name.endsWith(".rels") });
  } catch {
    throw new Error(`the ${ext} file could not be opened`);
  }
  const xml = (name: string) => (files[name] ? strFromU8(files[name]) : "");
  if (ext === ".docx") return docxText(xml("word/document.xml"));
  if (ext === ".pptx") {
    const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => numbered(a) - numbered(b));
    return slides
      .map((s, i) => {
        const notes = paragraphs(xml(`ppt/notesSlides/notesSlide${numbered(s)}.xml`), "a:p", "a:t").replace(/^\d+$/m, "").trim();
        return `--- Slide ${i + 1} of ${slides.length} ---\n${paragraphs(xml(s), "a:p", "a:t") || "(no text on this slide)"}${notes ? `\nSpeaker notes: ${notes}` : ""}`;
      })
      .join("\n");
  }
  return xlsxText(files, xml);
}

/**
 * A Word document's paragraphs. Tabs and line breaks inside a paragraph keep words apart, and a
 * table row comes out as one line, its cells separated by " | ".
 */
function docxText(xml: string): string {
  const flat = xml.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:(?:br|cr)(?:\s[^>]*)?\/>/g, "<w:t>\n</w:t>");
  const rows = flat.replace(/<w:tr[\s>][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = row.split("</w:tc>").slice(0, -1).map((cell) => cell.split("</w:p>").map((p) => runsOf(p, "w:t")).join(" ").replace(/\s+/g, " ").trim());
    return `<w:p><w:r><w:t>${cells.join(" | ")}</w:t></w:r></w:p>`;
  });
  return paragraphs(rows, "w:p", "w:t");
}

/** A column's index from a cell reference: "A1" is 0, "AB7" is 27. */
const columnOf = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/**
 * Each sheet's rows, by the workbook's sheet order and names, cells separated by tabs in their own
 * columns (an empty cell keeps its place), shared and inline strings looked up.
 */
function xlsxText(files: Record<string, Uint8Array>, xml: (name: string) => string): string {
  const shared = [...xml("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXml(runsOf(m[1]!, "t")));
  const sheets = sheetsOf(files, xml);
  return sheets
    .map(({ path, name }, i) => {
      const rows = [...xml(path).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)].map((r) => rowText(r[1] ?? "", shared)).filter(Boolean);
      return `--- Sheet ${i + 1} of ${sheets.length}${name ? `: ${name}` : ""} ---\n${rows.join("\n")}`;
    })
    .join("\n");
}

function rowText(row: string, shared: string[]): string {
  const cells: string[] = [];
  for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [tag, body = ""] = [c[1]!, c[2]];
    const ref = attr(tag, "r");
    const at = ref ? columnOf(ref) : cells.length;
    const kind = attr(tag, "t");
    const value = body.match(/<v>([^<]*)<\/v>/)?.[1] ?? "";
    const text = kind === "s" ? shared[Number(value)] ?? "" : kind === "inlineStr" ? decodeXml(runsOf(body, "t")) : kind === "b" ? (value === "1" ? "TRUE" : "FALSE") : decodeXml(value);
    while (cells.length < at) cells.push("");
    cells[Math.max(at, cells.length)] = text;
  }
  while (cells.length && !cells.at(-1)) cells.pop();
  return cells.join("\t");
}

/** Sheet files with their names, in the workbook's order; numbered order when the workbook doesn't say. */
function sheetsOf(files: Record<string, Uint8Array>, xml: (name: string) => string): { path: string; name?: string }[] {
  const targets = new Map([...xml("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
  const named = [...xml("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)]
    .map((m) => {
      const target = targets.get(attr(m[0], "r:id"))?.replace(/^\//, "");
      return { path: target?.startsWith("xl/") ? target : `xl/${target}`, name: decodeXml(attr(m[0], "name") ?? "") };
    })
    .filter((s) => files[s.path]);
  if (named.length) return named;
  return Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => numbered(a) - numbered(b))
    .map((path) => ({ path }));
}

/** A web page's text: a line per block, table cells separated by " | ", entities decoded. */
function htmlText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/(p|div|li|h\d|tr|br|section|article|header|footer|blockquote|pre|dt|dd|table|caption)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
  return decodeXml(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .replace(/ ?\|$/gm, "")
    .trim();
}

/** Part of a long text, from character `from`, with a note on what is left. */
export function part(text: string, from = 0, tool = "read_document"): string {
  if (text && from >= text.length) return `(The text ends at character ${text.length}; there is no more.)`;
  const start = Math.max(0, from);
  const end = Math.min(text.length, start + PART_CHARS);
  const rest = end < text.length ? `\n\n(Characters ${start}–${end} of ${text.length}. Call ${tool} again with from=${end} for more.)` : "";
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
