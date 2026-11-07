/**
 * Reads policies the way Chromium's PolicyLoaderMac does: CFPreferencesCopyAppValue for the value
 * and CFPreferencesAppValueIsForced for whether an MDM profile forces it. Called in-process with
 * bun:ffi. CoreFoundation values become JSON values by type (boolean, number, string, array,
 * dictionary); anything else (dates, data) is dropped. On other systems there are no values.
 *
 * CoreFoundation references travel as 64-bit integers (bigint), never as JS numbers: short strings
 * and small numbers are tagged pointers with the top bit set, which a double cannot hold exactly.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import type { PolicySource, PolicyValue } from "./policy";

export const PERCH_DOMAIN = "co.xanom.perch";

const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const UTF8 = 0x08000100;
const DOUBLE = 13;
const MAX_DEPTH = 6;
const MAX_ITEMS = 1000;
const REF = FFIType.u64;

type Ref = bigint;
type Lib = ReturnType<typeof open>;
let lib: Lib | null = null;

function open() {
  const { symbols } = dlopen(CORE_FOUNDATION, {
    CFStringCreateWithCString: { args: [REF, FFIType.ptr, FFIType.u32], returns: REF },
    CFPreferencesAppSynchronize: { args: [REF], returns: FFIType.bool },
    CFPreferencesCopyAppValue: { args: [REF, REF], returns: REF },
    CFPreferencesAppValueIsForced: { args: [REF, REF], returns: FFIType.bool },
    CFGetTypeID: { args: [REF], returns: FFIType.u64 },
    CFBooleanGetTypeID: { args: [], returns: FFIType.u64 },
    CFNumberGetTypeID: { args: [], returns: FFIType.u64 },
    CFStringGetTypeID: { args: [], returns: FFIType.u64 },
    CFArrayGetTypeID: { args: [], returns: FFIType.u64 },
    CFDictionaryGetTypeID: { args: [], returns: FFIType.u64 },
    CFBooleanGetValue: { args: [REF], returns: FFIType.bool },
    CFNumberGetValue: { args: [REF, FFIType.i64, FFIType.ptr], returns: FFIType.bool },
    CFStringGetLength: { args: [REF], returns: FFIType.i64 },
    CFStringGetMaximumSizeForEncoding: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i64 },
    CFStringGetCString: { args: [REF, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
    CFArrayGetCount: { args: [REF], returns: FFIType.i64 },
    CFArrayGetValueAtIndex: { args: [REF, FFIType.i64], returns: REF },
    CFDictionaryGetCount: { args: [REF], returns: FFIType.i64 },
    CFDictionaryGetKeysAndValues: { args: [REF, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    CFRelease: { args: [REF], returns: FFIType.void },
  });
  return symbols;
}

function cf(): Lib {
  lib ??= open();
  return lib;
}

function cfString(text: string): Ref {
  const bytes = Buffer.from(`${text}\0`, "utf8");
  const ref = cf().CFStringCreateWithCString(0n, ptr(bytes), UTF8);
  if (!ref) throw new Error("CoreFoundation could not make a string");
  return ref;
}

function readString(ref: Ref): string | undefined {
  const c = cf();
  const size = Number(c.CFStringGetMaximumSizeForEncoding(c.CFStringGetLength(ref), UTF8)) + 1;
  if (size <= 1 || size > 1 << 20) return size === 1 ? "" : undefined;
  const buf = Buffer.alloc(size);
  if (!c.CFStringGetCString(ref, ptr(buf), size, UTF8)) return undefined;
  return buf.toString("utf8", 0, buf.indexOf(0));
}

function readArray(ref: Ref, depth: number): unknown[] {
  const c = cf();
  const count = Math.min(Number(c.CFArrayGetCount(ref)), MAX_ITEMS);
  const items: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const item = toJson(c.CFArrayGetValueAtIndex(ref, i), depth + 1);
    if (item !== undefined) items.push(item);
  }
  return items;
}

function readDictionary(ref: Ref, depth: number): Record<string, unknown> {
  const c = cf();
  const count = Math.min(Number(c.CFDictionaryGetCount(ref)), MAX_ITEMS);
  const out: Record<string, unknown> = {};
  if (!count) return out;
  const keys = new BigUint64Array(count);
  const values = new BigUint64Array(count);
  c.CFDictionaryGetKeysAndValues(ref, ptr(keys), ptr(values));
  for (let i = 0; i < count; i++) {
    const key = keys[i] && c.CFGetTypeID(keys[i]!) === c.CFStringGetTypeID() ? readString(keys[i]!) : undefined;
    const value = toJson(values[i]!, depth + 1);
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

/** One CoreFoundation property-list value as JSON; undefined for types policies never use. */
function toJson(ref: Ref, depth = 0): unknown {
  if (!ref || depth > MAX_DEPTH) return undefined;
  const c = cf();
  const type = c.CFGetTypeID(ref);
  if (type === c.CFBooleanGetTypeID()) return c.CFBooleanGetValue(ref);
  if (type === c.CFNumberGetTypeID()) {
    const out = new Float64Array(1);
    return c.CFNumberGetValue(ref, DOUBLE, ptr(out)) ? out[0] : undefined;
  }
  if (type === c.CFStringGetTypeID()) return readString(ref);
  if (type === c.CFArrayGetTypeID()) return readArray(ref, depth);
  if (type === c.CFDictionaryGetTypeID()) return readDictionary(ref, depth);
  return undefined;
}

function readOne(app: Ref, name: string): PolicyValue | null {
  const c = cf();
  const key = cfString(name);
  try {
    const ref = c.CFPreferencesCopyAppValue(key, app);
    if (!ref) return null;
    try {
      const value = toJson(ref);
      return value === undefined ? null : { name, value, forced: c.CFPreferencesAppValueIsForced(key, app) };
    } finally {
      c.CFRelease(ref);
    }
  } finally {
    c.CFRelease(key);
  }
}

/** The managed (and user) preferences of an app domain, as CFPreferences reports them. */
export function cfPreferences(domain = PERCH_DOMAIN): PolicySource {
  return {
    read(names) {
      if (process.platform !== "darwin") return [];
      const app = cfString(domain);
      try {
        cf().CFPreferencesAppSynchronize(app);
        return names.map((name) => readOne(app, name)).filter((v): v is PolicyValue => v !== null);
      } finally {
        cf().CFRelease(app);
      }
    },
  };
}

/** A source for tests: fixed values. */
export function fakeSource(values: readonly PolicyValue[] | (() => readonly PolicyValue[])): PolicySource {
  return { read: (names) => (typeof values === "function" ? values() : values).filter((v) => names.includes(v.name)) };
}
