/** A throwaway keychain file with a fake password, so tests never touch the user's keychains. */

import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
  SecKeychainCreate: { args: [FFIType.cstring, FFIType.u32, FFIType.ptr, FFIType.bool, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SecKeychainDelete: { args: [FFIType.ptr], returns: FFIType.i32 },
}).symbols;

export function tempKeychain(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "perch-kc-"));
  const path = join(dir, "test.keychain-db");
  const password = Buffer.from("fake-test-keychain-password");
  const out = new BigUint64Array(1);
  const status = sec.SecKeychainCreate(Buffer.from(`${path}\0`), password.length, password, false, null, out);
  if (status !== 0) throw new Error(`SecKeychainCreate failed (${status})`);
  return {
    path,
    cleanup: () => {
      sec.SecKeychainDelete(Number(out[0]) as Pointer);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
