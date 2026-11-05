/**
 * The macOS Keychain through Security.framework, called in-process with bun:ffi. Calling it from
 * perchd itself (not through /usr/bin/security) matters: a new item's access list then trusts
 * only the program that created it, so other processes, MCP servers included, cannot read it
 * without a prompt. In a release that program is the signed perchd binary; in development it is
 * the bun binary running perchd, so during development any bun program can still read Perch's items.
 *
 * These are the file-based Keychain calls (SecKeychain*). They take plain C arguments, so no
 * CoreFoundation dictionaries are needed.
 */

import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";

export const ERR_NOT_FOUND = -25300;
export const ERR_DUPLICATE = -25299;

const SECURITY = "/System/Library/Frameworks/Security.framework/Security";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

type Lib = ReturnType<typeof open>;
let lib: Lib | null = null;

function open() {
  const sec = dlopen(SECURITY, {
    SecKeychainCreate: { args: [FFIType.cstring, FFIType.u32, FFIType.ptr, FFIType.bool, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainDelete: { args: [FFIType.ptr], returns: FFIType.i32 },
    SecKeychainAddGenericPassword: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainFindGenericPassword: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainItemModifyAttributesAndData: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainItemDelete: { args: [FFIType.ptr], returns: FFIType.i32 },
    SecKeychainItemFreeContent: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const cf = dlopen(CORE_FOUNDATION, { CFRelease: { args: [FFIType.ptr], returns: FFIType.void } });
  return { ...sec.symbols, CFRelease: cf.symbols.CFRelease };
}

function security(): Lib {
  if (process.platform !== "darwin") throw new Error("the Keychain is only available on macOS");
  lib ??= open();
  return lib;
}

function check(status: number, what: string): void {
  if (status !== 0) throw new Error(`Keychain ${what} failed (status ${status})`);
}

/** A keychain to work in: null is the user's default (login) keychain. */
export type KeychainRef = Pointer | null;

type Found = { status: number; value?: Buffer; item?: Pointer };

function find(keychain: KeychainRef, service: Buffer, account: Buffer, wantItem: boolean): Found {
  const s = security();
  const length = new Uint32Array(1);
  const data = new BigUint64Array(1);
  const item = new BigUint64Array(1);
  const status = s.SecKeychainFindGenericPassword(keychain, service.length, ptr(service), account.length, ptr(account), ptr(length), ptr(data), wantItem ? ptr(item) : null);
  if (status !== 0) return { status };
  const at = Number(data[0]) as Pointer;
  const value = length[0] ? Buffer.from(new Uint8Array(toArrayBuffer(at, 0, length[0]!)).slice()) : Buffer.alloc(0);
  s.SecKeychainItemFreeContent(null, at);
  return { status, value, ...(wantItem ? { item: Number(item[0]) as Pointer } : {}) };
}

export function readPassword(keychain: KeychainRef, service: string, account: string): Buffer | null {
  const r = find(keychain, Buffer.from(service), Buffer.from(account), false);
  if (r.status === ERR_NOT_FOUND) return null;
  check(r.status, "read");
  return r.value!;
}

/** Creates the item; returns false, changing nothing, when it already exists. */
export function addPassword(keychain: KeychainRef, service: string, account: string, value: Buffer): boolean {
  const svc = Buffer.from(service);
  const acc = Buffer.from(account);
  const status = security().SecKeychainAddGenericPassword(keychain, svc.length, ptr(svc), acc.length, ptr(acc), value.length, value.length ? ptr(value) : null, null);
  if (status === ERR_DUPLICATE) return false;
  check(status, "write");
  return true;
}

/** Changes the item's value, creating it when missing. */
export function writePassword(keychain: KeychainRef, service: string, account: string, value: Buffer): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = find(keychain, Buffer.from(service), Buffer.from(account), true);
    if (r.status === ERR_NOT_FOUND) {
      if (addPassword(keychain, service, account, value)) return;
      continue; // created by someone else in between: update it instead
    }
    check(r.status, "read");
    try {
      check(security().SecKeychainItemModifyAttributesAndData(r.item!, null, value.length, value.length ? ptr(value) : null), "write");
      return;
    } finally {
      security().CFRelease(r.item!);
    }
  }
  throw new Error("Keychain write failed (the item kept changing)");
}

export function deletePassword(keychain: KeychainRef, service: string, account: string): void {
  const r = find(keychain, Buffer.from(service), Buffer.from(account), true);
  if (r.status === ERR_NOT_FOUND) return;
  check(r.status, "read");
  try {
    const status = security().SecKeychainItemDelete(r.item!);
    if (status !== ERR_NOT_FOUND) check(status, "delete");
  } finally {
    security().CFRelease(r.item!);
  }
}

/** A separate keychain file, for tests: it is never added to the user's search list. */
export function createKeychain(path: string, password: string): { ref: Pointer; destroy: () => void } {
  const s = security();
  const pw = Buffer.from(password);
  const out = new BigUint64Array(1);
  check(s.SecKeychainCreate(Buffer.from(`${path}\0`), pw.length, ptr(pw), false, null, ptr(out)), "create");
  const ref = Number(out[0]) as Pointer;
  return {
    ref,
    destroy: () => {
      s.SecKeychainDelete(ref);
      s.CFRelease(ref);
    },
  };
}
