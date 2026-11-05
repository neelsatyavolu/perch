import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { parseBinaryCookies, readSafariCookies, safariCookiesPath } from "../../src/import/safari/binarycookies";
import { browserByKey } from "../../src/import/catalog";
import { readerFor } from "../../src/import/reader";
import { toMac } from "../../src/import/time";
import { T0, tempHome, write } from "./fixtures";

type Fake = { domain: string; name: string; path: string; value: string; flags: number; expires: number };

/** Encodes cookies in Safari's Cookies.binarycookies layout (big-endian file header, little-endian pages). */
function encode(pages: readonly (readonly Fake[])[]): Buffer {
  const pageBufs = pages.map((cookies) => {
    const records = cookies.map((c) => {
      const strings = [c.domain, c.name, c.path, c.value].map((s) => Buffer.from(`${s}\0`));
      const head = Buffer.alloc(56);
      let offset = 56;
      const offsets = strings.map((s) => ((offset += s.length), offset - s.length));
      head.writeUInt32LE(56 + strings.reduce((n, s) => n + s.length, 0), 0);
      head.writeUInt32LE(c.flags, 8);
      offsets.forEach((o, i) => head.writeUInt32LE(o, 16 + i * 4));
      head.writeDoubleLE(toMac(c.expires), 40);
      head.writeDoubleLE(toMac(T0), 48);
      return Buffer.concat([head, ...strings]);
    });
    const header = Buffer.alloc(8 + 4 * records.length + 4);
    header.writeUInt32BE(0x100, 0);
    header.writeUInt32LE(records.length, 4);
    let at = header.length;
    records.forEach((r, i) => {
      header.writeUInt32LE(at, 8 + i * 4);
      at += r.length;
    });
    return Buffer.concat([header, ...records]);
  });
  const head = Buffer.alloc(8 + 4 * pageBufs.length);
  head.write("cook", 0, "ascii");
  head.writeUInt32BE(pageBufs.length, 4);
  pageBufs.forEach((p, i) => head.writeUInt32BE(p.length, 8 + i * 4));
  return Buffer.concat([head, ...pageBufs, Buffer.alloc(8)]);
}

let env: { home: string; cleanup: () => void };
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const future = Date.now() + 86_400_000;
const FIXTURE = encode([
  [
    { domain: ".example.com", name: "sid", path: "/", value: "safari-test-value", flags: 5, expires: future },
    { domain: "old.example.com", name: "gone", path: "/", value: "x", flags: 0, expires: T0 - 86_400_000 },
  ],
  [{ domain: "news.example.com", name: "pref", path: "/a", value: "dark", flags: 0, expires: future }],
]);

test("Safari's binary cookies parse across pages: flags, expiry, expired ones dropped", () => {
  const cookies = parseBinaryCookies(FIXTURE);
  expect(cookies).toEqual([
    { name: "sid", value: "safari-test-value", domain: ".example.com", path: "/", expires: Math.floor(future / 1000), secure: true, httpOnly: true },
    { name: "pref", value: "dark", domain: "news.example.com", path: "/a", expires: Math.floor(future / 1000), secure: false, httpOnly: false },
  ]);
  expect(() => parseBinaryCookies(Buffer.from("nope"))).toThrow();
  // Offsets that point outside the file are rejected rather than read.
  const bad = Buffer.from(FIXTURE);
  bad.writeUInt32BE(0xffffff, 8);
  expect(() => parseBinaryCookies(bad)).toThrow();
});

test("the Safari reader finds the container cookie file and imports it with Full Disk Access", async () => {
  const safari = join(env.home, "Library", "Safari");
  write(join(safari, "placeholder"), "");
  const path = join(env.home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies");
  write(path, FIXTURE);
  expect(safariCookiesPath(safari)).toBe(path);
  expect(await readSafariCookies(safari)).toHaveLength(2);
  const reader = readerFor(browserByKey("safari")!, { id: "", name: "Safari", path: safari });
  expect(reader.types).toContain("cookies");
  expect(reader.needsFullDiskAccess).toContain("cookies");
  expect(await reader.count("cookies")).toBe(3);
  expect((await reader.read("cookies", undefined as never)).data.cookies).toHaveLength(2);
});
