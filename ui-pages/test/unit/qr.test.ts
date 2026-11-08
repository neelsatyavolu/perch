import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { qrMatrix } from "../../src/lib/qr";

const bits = (m: boolean[][]) => m.map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n");

describe("QR encoder", () => {
  test("picks the smallest version that fits", () => {
    expect(qrMatrix("hi").length).toBe(21);
    expect(qrMatrix("x".repeat(20)).length).toBe(25);
    expect(qrMatrix("perch://pair?code=ABCDEFGHJKLM").length).toBe(29);
    expect(() => qrMatrix("y".repeat(43))).toThrow("Too long");
  });

  test("draws the three finders, the timing lines and the dark module", () => {
    const m = qrMatrix("perch://pair?code=ABCDEFGHJKLM");
    const n = m.length;
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      expect(m[r]!.slice(c, c + 7)).toEqual([true, true, true, true, true, true, true]);
      expect(m[r + 3]!.slice(c, c + 7)).toEqual([true, false, true, true, true, false, true]);
    }
    expect(m[6]!.slice(8, n - 8).map((b, i) => b === (i % 2 === 0)).every(Boolean)).toBe(true);
    expect(m[n - 8]![8]).toBe(true);
  });

  test("matches the qrcode library's output for the pairing payload (byte mode, level M, mask 0)", () => {
    // Checked module for module against qrcode 1.5.4 when this encoder was written.
    const hash = createHash("sha256").update(bits(qrMatrix("perch://pair?code=ABCDEFGHJKLM"))).digest("hex");
    expect(hash).toBe("55a9a3f252c941c5bf4df657d7a0c4b5aa70472c8215807679eeb54db0ea583d");
  });
});
