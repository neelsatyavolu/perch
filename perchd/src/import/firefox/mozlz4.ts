/**
 * Firefox's mozLz4 files: "mozLz40\0", the decompressed size as uint32 LE, then one LZ4 block.
 */

const MAGIC = "mozLz40\0";
const MAX_OUTPUT = 256 * 1024 * 1024;

export function decodeMozLz4(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString("latin1", 0, 8) !== MAGIC) throw new Error("not a mozLz4 file");
  const size = buf.readUInt32LE(8);
  if (size > MAX_OUTPUT) throw new Error("mozLz4 file too large");
  return decodeLz4Block(buf.subarray(12), size);
}

export function decodeLz4Block(src: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size);
  let i = 0;
  let o = 0;
  const length = (base: number): number => {
    let n = base;
    if (base === 15) {
      let b: number;
      do {
        if (i >= src.length) throw new Error("damaged LZ4 block");
        b = src[i++]!;
        n += b;
      } while (b === 255);
    }
    return n;
  };
  while (i < src.length) {
    const token = src[i++]!;
    const literals = length(token >> 4);
    if (i + literals > src.length || o + literals > size) throw new Error("damaged LZ4 block");
    src.copy(out, o, i, i + literals);
    i += literals;
    o += literals;
    if (i >= src.length) break; // the last sequence has literals only
    const offset = src[i]! | (src[i + 1]! << 8);
    i += 2;
    const match = length(token & 15) + 4;
    if (offset === 0 || offset > o || o + match > size) throw new Error("damaged LZ4 block");
    for (let k = 0; k < match; k++, o++) out[o] = out[o - offset]!;
  }
  return out.subarray(0, o);
}
