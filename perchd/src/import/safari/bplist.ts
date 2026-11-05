/**
 * A reader for Apple's binary property lists ("bplist00"), enough for Safari's Bookmarks.plist.
 * Layout: header, objects, an offset table, and a 32-byte trailer that says where things are.
 */

export type PlistValue = null | boolean | number | bigint | string | Date | Uint8Array | PlistValue[] | { [key: string]: PlistValue };

const MAX_OBJECTS = 5_000_000;
const MAX_DEPTH = 256;
const MAC_EPOCH_MS = 978_307_200_000;

export function parseBplist(buf: Buffer): PlistValue {
  if (buf.length < 40 || buf.toString("latin1", 0, 8) !== "bplist00") throw new Error("not a binary plist");
  const t = buf.length - 32;
  const offsetSize = buf[t + 6]!;
  const refSize = buf[t + 7]!;
  const count = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableAt = Number(buf.readBigUInt64BE(t + 24));
  if (count > MAX_OBJECTS || top >= count || tableAt + count * offsetSize > t || offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw new Error("damaged plist trailer");

  const uint = (at: number, size: number): number => {
    if (at + size > buf.length) throw new Error("damaged plist");
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[at + i]!;
    return v;
  };
  const offset = (ref: number) => uint(tableAt + ref * offsetSize, offsetSize);

  const read = (ref: number, depth: number): PlistValue => {
    if (ref >= count || depth > MAX_DEPTH) throw new Error("damaged plist");
    const at = offset(ref);
    const marker = buf[at]!;
    const type = marker >> 4;
    const info = marker & 0x0f;
    // Length of strings, data, arrays and dicts: inline, or a following int object when info is 0xF.
    const length = (): [number, number] => {
      if (info !== 0x0f) return [info, at + 1];
      const intMarker = buf[at + 1]!;
      const size = 1 << (intMarker & 0x0f);
      return [uint(at + 2, size), at + 2 + size];
    };
    switch (type) {
      case 0x0:
        return info === 0x09 ? true : info === 0x08 ? false : null;
      case 0x1: {
        const size = 1 << info;
        if (size < 8) return uint(at + 1, size);
        const v = buf.readBigInt64BE(at + 1 + (size - 8)); // 16-byte ints keep their value in the low 8 bytes
        return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      case 0x2:
        return info === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
      case 0x3:
        return new Date(MAC_EPOCH_MS + buf.readDoubleBE(at + 1) * 1000);
      case 0x4: {
        const [n, start] = length();
        return new Uint8Array(buf.subarray(start, start + n));
      }
      case 0x5: {
        const [n, start] = length();
        return buf.toString("latin1", start, start + n);
      }
      case 0x6: {
        const [n, start] = length();
        const be = buf.subarray(start, start + n * 2);
        const le = Buffer.alloc(be.length);
        for (let i = 0; i + 1 < be.length; i += 2) {
          le[i] = be[i + 1]!;
          le[i + 1] = be[i]!;
        }
        return le.toString("utf16le");
      }
      case 0x8:
        return uint(at + 1, info + 1);
      case 0xa: {
        const [n, start] = length();
        return Array.from({ length: n }, (_, i) => read(uint(start + i * refSize, refSize), depth + 1));
      }
      case 0xd: {
        const [n, start] = length();
        const entries: [string, PlistValue][] = [];
        for (let i = 0; i < n; i++) {
          const key = read(uint(start + i * refSize, refSize), depth + 1);
          entries.push([String(key), read(uint(start + (n + i) * refSize, refSize), depth + 1)]);
        }
        return Object.fromEntries(entries);
      }
      default:
        throw new Error(`unsupported plist object type ${type}`);
    }
  };
  return read(top, 0);
}
