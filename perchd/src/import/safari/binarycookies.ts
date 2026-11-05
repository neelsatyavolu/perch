/**
 * Safari's cookies: Cookies.binarycookies in Safari's container (macOS protects it, so it needs
 * Full Disk Access like the rest of Safari's files).
 *
 * Layout: "cook" | page count (u32 BE) | page sizes (u32 BE each) | pages | checksum.
 * Page: 0x00000100 | cookie count (u32 LE) | cookie offsets (u32 LE, from the page start) | ...
 * Cookie (LE): size | ? | flags (1 secure, 4 HttpOnly) | ? | domain, name, path, value offsets
 * (from the cookie start, NUL-terminated) | 8 bytes | expiry, creation (f64, seconds since 2001).
 * Every offset is checked against the buffer, since the file is outside Perch's control.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { permissionError } from "../sqlite-copy";
import { fromMac } from "../time";
import { ImportError, type Cookie } from "../types";

const SECURE = 1;
const HTTP_ONLY = 4;
const COOKIE_HEADER = 56;

function bad(): never {
  throw new ImportError("Safari's cookie file could not be read.", "unreadable");
}

function cString(buf: Buffer, start: number, end: number): string {
  if (start < 0 || start >= end) bad();
  const nul = buf.indexOf(0, start);
  if (nul < 0 || nul >= end) bad();
  return buf.toString("utf8", start, nul);
}

function parseCookie(buf: Buffer, start: number, pageEnd: number): { cookie: Omit<Cookie, "expires">; expires?: number } {
  if (start + COOKIE_HEADER > pageEnd) bad();
  const size = buf.readUInt32LE(start);
  const end = start + size;
  if (size < COOKIE_HEADER || end > pageEnd) bad();
  const flags = buf.readUInt32LE(start + 8);
  const [domain, name, path, value] = [16, 20, 24, 28].map((o) => cString(buf, start + buf.readUInt32LE(start + o), end)) as [string, string, string, string];
  const expiresMs = fromMac(buf.readDoubleLE(start + 40));
  return {
    cookie: { name, value, domain, path: path || "/", secure: (flags & SECURE) !== 0, httpOnly: (flags & HTTP_ONLY) !== 0 },
    ...(expiresMs !== undefined ? { expires: expiresMs } : {}),
  };
}

/** Every cookie in the file, minus expired ones. Throws ImportError("unreadable") on a damaged file. */
export function parseBinaryCookies(buf: Buffer, now = Date.now()): Cookie[] {
  if (buf.length < 8 || buf.toString("ascii", 0, 4) !== "cook") bad();
  const pages = buf.readUInt32BE(4);
  if (8 + pages * 4 > buf.length) bad();
  const cookies: Cookie[] = [];
  let pageStart = 8 + pages * 4;
  for (let p = 0; p < pages; p++) {
    const pageEnd = pageStart + buf.readUInt32BE(8 + p * 4);
    if (pageEnd > buf.length || pageStart + 8 > pageEnd || buf.readUInt32BE(pageStart) !== 0x100) bad();
    const count = buf.readUInt32LE(pageStart + 4);
    if (pageStart + 8 + count * 4 > pageEnd) bad();
    for (let i = 0; i < count; i++) {
      const { cookie, expires } = parseCookie(buf, pageStart + buf.readUInt32LE(pageStart + 8 + i * 4), pageEnd);
      if (expires !== undefined && expires <= now) continue;
      cookies.push(expires !== undefined ? { ...cookie, expires: Math.floor(expires / 1000) } : cookie);
    }
    pageStart = pageEnd;
  }
  return cookies;
}

/** `safariDir` is ~/Library/Safari; the cookie file lives in Safari's container, or in ~/Library/Cookies on old macOS. */
export function safariCookiesPath(safariDir: string): string | undefined {
  const library = join(safariDir, "..");
  return [join(library, "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies"), join(library, "Cookies", "Cookies.binarycookies")].find(
    (p) => existsSync(p),
  );
}

function readFile(safariDir: string): Buffer | undefined {
  const path = safariCookiesPath(safariDir);
  if (!path) return undefined;
  try {
    return readFileSync(path);
  } catch (error) {
    throw permissionError(error, path) ?? error;
  }
}

export async function readSafariCookies(safariDir: string): Promise<Cookie[]> {
  const buf = readFile(safariDir);
  return buf ? parseBinaryCookies(buf) : [];
}

/** All cookies in the file, expired ones included, as Chromium's count does. */
export async function countSafariCookies(safariDir: string): Promise<number> {
  const buf = readFile(safariDir);
  return buf ? parseBinaryCookies(buf, -Infinity).length : 0;
}
