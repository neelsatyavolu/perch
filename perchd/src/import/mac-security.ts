/**
 * Security.framework, called in-process through bun:ffi rather than through /usr/bin/security.
 *
 * Why: macOS attaches Keychain trust to the process that asks. Shelling out to `security`
 * made macOS ask about that shared system tool, and "Always Allow" (or creating an item through
 * it) put /usr/bin/security on the item's access list, after which any process could read the
 * item with no prompt. Calling the framework from perchd itself makes the prompt name perchd,
 * and new items trust only perchd and the apps the caller names (Perch.app).
 *
 * Uses the file-based Keychain API (SecKeychain*). It is deprecated but is the only API that
 * reads other apps' legacy items such as "Chrome Safe Storage" and sets an access list on create.
 */

import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";

const { i32, u32, i64, ptr: P, cstring, void: VOID } = FFIType;

export const ERR_NOT_FOUND = -25300;
export const ERR_DUPLICATE = -25299;

const GENERIC_PASSWORD = 0x67656e70; // 'genp'
const ATTR = { service: 0x73766365, account: 0x61636374, label: 0x6c61626c } as const; // 'svce' 'acct' 'labl'
const UTF8 = 0x08000100;

let lib: ReturnType<typeof load> | undefined;
function load() {
  const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
    SecKeychainOpen: { args: [cstring, P], returns: i32 },
    SecKeychainFindGenericPassword: { args: [P, u32, P, u32, P, P, P, P], returns: i32 },
    SecKeychainItemFreeContent: { args: [P, P], returns: i32 },
    SecKeychainItemDelete: { args: [P], returns: i32 },
    SecKeychainItemCreateFromContent: { args: [u32, P, u32, P, P, P, P], returns: i32 },
    SecTrustedApplicationCreateFromPath: { args: [P, P], returns: i32 },
    SecAccessCreate: { args: [P, P, P], returns: i32 },
  });
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFRelease: { args: [P], returns: VOID },
    CFStringCreateWithCString: { args: [P, cstring, u32], returns: P },
    CFArrayCreate: { args: [P, P, i64, P], returns: P },
  });
  return { ...sec.symbols, ...cf.symbols };
}
const api = () => (lib ??= load());

type Ref = Pointer;
const outRef = () => new BigUint64Array(1);
const refOf = (out: BigUint64Array): Ref => Number(out[0]) as Ref;
const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");
const bytes = (s: string) => Buffer.from(s, "utf8");

export type SecurityApi = {
  /** status 0 with the value, or the OSStatus (ERR_NOT_FOUND, -128 when the user said no, ...). */
  find(service: string, account?: string): { status: number; value?: string };
  /** Creates the item; its access list trusts this process and `trustedApps` only. */
  add(service: string, account: string, value: string, trustedApps: readonly string[]): number;
  remove(service: string, account: string): number;
};

/** `keychainPath` targets one keychain file (tests); otherwise the user's default keychains. */
export function securityFramework(keychainPath?: string): SecurityApi {
  const keychain = (): Ref | null => {
    if (!keychainPath) return null;
    const out = outRef();
    const status = api().SecKeychainOpen(cstr(keychainPath), out);
    if (status !== 0) throw new Error(`SecKeychainOpen failed (${status})`);
    return refOf(out);
  };
  const withKeychain = <T>(fn: (kc: Ref | null) => T): T => {
    const kc = keychain();
    try {
      return fn(kc);
    } finally {
      if (kc) api().CFRelease(kc);
    }
  };
  const findItem = (kc: Ref | null, service: string, account: string | undefined, wantItem: boolean) => {
    const svc = bytes(service);
    const acct = bytes(account ?? "");
    const len = new Uint32Array(1);
    const data = outRef();
    const item = outRef();
    const status = api().SecKeychainFindGenericPassword(kc, svc.length, svc, acct.length, acct.length ? acct : null, len, data, wantItem ? item : null);
    if (status !== 0) return { status };
    const raw = refOf(data);
    const value = Buffer.from(toArrayBuffer(raw, 0, len[0]!)).toString("utf8");
    api().SecKeychainItemFreeContent(null, raw);
    return { status, value, item: wantItem ? refOf(item) : null };
  };
  return {
    find: (service, account) =>
      withKeychain((kc) => {
        const { status, value } = findItem(kc, service, account, false);
        return status === 0 ? { status, value } : { status };
      }),
    add: (service, account, value, trustedApps) => withKeychain((kc) => addItem(kc, service, account, value, trustedApps)),
    remove: (service, account) =>
      withKeychain((kc) => {
        const found = findItem(kc, service, account, true);
        if (found.status !== 0 || !found.item) return found.status;
        try {
          return api().SecKeychainItemDelete(found.item);
        } finally {
          api().CFRelease(found.item);
        }
      }),
  };
}

function addItem(kc: Ref | null, service: string, account: string, value: string, trustedApps: readonly string[]): number {
  const f = api();
  const apps: Ref[] = [];
  const release: Ref[] = [];
  try {
    // A null path means "this process": perchd itself.
    for (const path of [null, ...trustedApps]) {
      const out = outRef();
      const status = f.SecTrustedApplicationCreateFromPath(path === null ? null : cstr(path), out);
      if (status !== 0) return status;
      apps.push(refOf(out));
    }
    const list = new BigUint64Array(apps.map(BigInt));
    const array = f.CFArrayCreate(null, list, apps.length, null);
    const label = f.CFStringCreateWithCString(null, cstr(service), UTF8);
    if (!array || !label) return -108; // memFullErr
    release.push(array, label);
    const accessOut = outRef();
    const accessStatus = f.SecAccessCreate(label, array, accessOut);
    if (accessStatus !== 0) return accessStatus;
    release.unshift(refOf(accessOut));
    const fields = [
      [ATTR.service, bytes(service)],
      [ATTR.account, bytes(account)],
      [ATTR.label, bytes(service)],
    ] as const;
    // SecKeychainAttribute { UInt32 tag; UInt32 length; void *data } and SecKeychainAttributeList { UInt32 count; SecKeychainAttribute *attr }.
    const attrs = Buffer.alloc(16 * fields.length);
    fields.forEach(([tag, data], i) => {
      attrs.writeUInt32LE(tag, i * 16);
      attrs.writeUInt32LE(data.length, i * 16 + 4);
      attrs.writeBigUInt64LE(BigInt(ptr(data)), i * 16 + 8);
    });
    const attrList = Buffer.alloc(16);
    attrList.writeUInt32LE(fields.length, 0);
    attrList.writeBigUInt64LE(BigInt(ptr(attrs)), 8);
    const secret = bytes(value);
    const itemOut = outRef();
    const status = f.SecKeychainItemCreateFromContent(GENERIC_PASSWORD, attrList, secret.length, secret, kc, refOf(accessOut), itemOut);
    if (status === 0) release.push(refOf(itemOut));
    secret.fill(0);
    return status;
  } finally {
    for (const ref of [...release, ...apps]) if (ref) f.CFRelease(ref);
  }
}
