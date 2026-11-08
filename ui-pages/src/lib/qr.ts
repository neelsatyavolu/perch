/**
 * A small QR code encoder for the sync pairing code (Settings › Sync), so the page draws it with no
 * library and no network. Byte mode, error correction level M, versions 1 to 3 (up to 42 bytes),
 * which fits `perch://pair?code=…`. Mask pattern 0; every reader accepts any mask.
 */

/** Per version at level M: data codewords and error correction codewords (one block each). */
const VERSIONS = [
  { data: 16, ec: 10 },
  { data: 28, ec: 16 },
  { data: 44, ec: 26 },
] as const;

/* GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++, x = x & 0x80 ? ((x << 1) ^ 0x11d) & 0xff : x << 1) {
  EXP[i] = x;
  LOG[x] = i;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

function ecCodewords(data: readonly number[], count: number): number[] {
  let gen = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    gen.forEach((g, j) => {
      next[j] = next[j]! ^ g;
      next[j + 1] = next[j + 1]! ^ mul(g, EXP[i]!);
    });
    gen = next;
  }
  const rem = [...data, ...new Array<number>(count).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const f = rem[i]!;
    if (f) gen.forEach((g, j) => (rem[i + j] = rem[i + j]! ^ mul(g, f)));
  }
  return rem.slice(data.length);
}

function codewords(bytes: Uint8Array, version: number): number[] {
  const { data, ec } = VERSIONS[version - 1]!;
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, data * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0; out.length < data; pad++) out.push(pad % 2 ? 0x11 : 0xec);
  return [...out, ...ecCodewords(out, ec)];
}

/** Format information for level M (01) and mask 0, BCH-coded and masked. */
function formatBits(): number {
  const info = 0b00000;
  let rem = info << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((info << 10) | rem) ^ 0x5412;
}

/** The QR code for `text` as rows of dark (true) and light modules, without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = VERSIONS.findIndex((v) => v.data - 2 >= bytes.length) + 1;
  if (version === 0) throw new Error("Too long for this QR encoder");
  const size = 17 + version * 4;
  const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, on: boolean) => {
    dark[r]![c] = on;
    fixed[r]![c] = true;
  };

  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, ring !== 2 && ring !== 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  if (version > 1) {
    const at = size - 7;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(at + r, at + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
  }
  set(size - 8, 8, true);

  const format = formatBits();
  const bit = (i: number) => ((format >> i) & 1) === 1;
  for (let i = 0; i < 15; i++) {
    // Around the top-left finder.
    if (i < 6) set(i, 8, bit(i));
    else if (i < 8) set(i + 1, 8, bit(i));
    else if (i === 8) set(8, 7, bit(i));
    else set(8, 14 - i, bit(i));
    // Beside the other two finders.
    if (i < 8) set(8, size - 1 - i, bit(i));
    else set(size - 15 + i, 8, bit(i));
  }

  const bits = codewords(bytes, version).flatMap((w) => Array.from({ length: 8 }, (_, i) => ((w >> (7 - i)) & 1) === 1));
  let k = 0;
  for (let right = size - 1, up = true; right > 0; right -= 2, up = !up) {
    if (right === 6) right = 5;
    for (let n = 0; n < size; n++) {
      const r = up ? size - 1 - n : n;
      for (const c of [right, right - 1]) {
        if (fixed[r]![c]) continue;
        const on = k < bits.length ? bits[k++]! : false;
        dark[r]![c] = on !== ((r + c) % 2 === 0);
      }
    }
  }
  return dark;
}
