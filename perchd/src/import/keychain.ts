/**
 * The macOS Keychain, behind a small interface so tests use an in-memory fake.
 *
 * Reading another browser's "<Browser> Safe Storage" item makes macOS show its own prompt
 * naming Perch ("perchd wants to use your confidential information stored in ..."); the user
 * can allow or deny it. The calls go straight to Security.framework from perchd (see
 * mac-security.ts), never through /usr/bin/security, so no Keychain item ever comes to trust
 * that shared tool.
 */

import { ERR_DUPLICATE, ERR_NOT_FOUND, securityFramework, type SecurityApi } from "./mac-security";
import { ImportError } from "./types";

export interface Keychain {
  /** The item's secret, or null when no such item exists. Throws ImportError("keychain-denied") when the user says no. */
  find(service: string, account?: string): Promise<string | null>;
  /** Creates or replaces an item whose access list trusts perchd and Perch.app only. */
  set(service: string, account: string, value: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}

export type MacKeychainOptions = {
  /** Absolute paths of other apps to trust on items Perch creates, such as Perch.app. perchd itself is always trusted. */
  readonly trustedApps?: readonly string[];
  /** A keychain file to use instead of the user's default keychains (tests). */
  readonly keychainPath?: string;
  /** The framework binding; replaced in tests. */
  readonly security?: SecurityApi;
};

function plain(s: string, what: string): string {
  if (typeof s !== "string" || s.length === 0 || s.length > 256 || /[\0\n\r]/.test(s)) throw new ImportError(`Keychain ${what} must be a short, plain name.`, "invalid");
  return s;
}

export function macKeychain(options: MacKeychainOptions = {}): Keychain {
  const trustedApps = (options.trustedApps ?? []).map((p) => {
    if (!p.startsWith("/")) throw new ImportError("Trusted apps must be absolute paths.", "invalid");
    return p;
  });
  const sec = options.security ?? securityFramework(options.keychainPath);
  return {
    async find(service, account) {
      const { status, value } = sec.find(plain(service, "service"), account === undefined ? undefined : plain(account, "account"));
      if (status === 0) return value ?? "";
      if (status === ERR_NOT_FOUND) return null;
      throw new ImportError(`macOS did not allow reading "${service}" from the Keychain. Choose Allow when macOS asks, or skip this data.`, "keychain-denied");
    },
    async set(service, account, value) {
      plain(service, "service");
      plain(account, "account");
      let status = sec.add(service, account, value, trustedApps);
      if (status === ERR_DUPLICATE) {
        sec.remove(service, account);
        status = sec.add(service, account, value, trustedApps);
      }
      if (status !== 0) throw new ImportError(`Could not save "${service}" to the Keychain.`, "keychain-denied");
    },
    async remove(service, account) {
      const status = sec.remove(plain(service, "service"), plain(account, "account"));
      if (status !== 0 && status !== ERR_NOT_FOUND) throw new ImportError(`Could not remove "${service}" from the Keychain.`, "keychain-denied");
    },
  };
}

/** In-memory Keychain for tests. `deny` lists services the "user" refuses. */
export function memoryKeychain(items: Record<string, string> = {}, deny: readonly string[] = []): Keychain & { readonly asked: readonly string[] } {
  const store = new Map(Object.entries(items));
  const asked: string[] = [];
  const key = (service: string, account?: string) => (account ? `${service}/${account}` : service);
  return {
    asked,
    async find(service, account) {
      asked.push(service);
      if (deny.includes(service)) throw new ImportError(`macOS did not allow reading "${service}" from the Keychain.`, "keychain-denied");
      return store.get(key(service, account)) ?? store.get(service) ?? null;
    },
    async set(service, account, value) {
      store.set(key(service, account), value);
    },
    async remove(service, account) {
      store.delete(key(service, account));
    },
  };
}
