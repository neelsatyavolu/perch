/**
 * Where Perch keeps secrets: API keys, sign-in tokens and the settings key (spec 11.1).
 * On the Mac this is the login Keychain through Bun.secrets (Keychain Services), so no secret is
 * ever passed on a command line or written to a file. Tests use the in-memory keychain.
 *
 * Scope: a login-Keychain item's access list trusts the program that created it. Run as
 * `bun run src/cli.ts`, that program is the shared `bun` binary, so any script bun runs (another
 * project's install script, say) can read these items without a prompt. Spec 7.3 and 11.1 want
 * them bound to Perch's code signature; that needs perchd shipped as a signed binary, or a signed
 * helper that sets the access list, which comes with the release packaging (plan 3b).
 */

import { secrets } from "bun";

export interface Keychain {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export const KEYCHAIN_SERVICE = "com.perch.perchd";
const NAME = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const MAX_VALUE = 64 * 1024;

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new KeychainError("Keychain item name must be lowercase letters, digits and :._-");
}

function checkValue(value: string): void {
  if (typeof value !== "string" || value.length === 0) throw new KeychainError("A Keychain item cannot be empty.");
  if (value.length > MAX_VALUE) throw new KeychainError("A Keychain item is limited to 64 KB.");
}

/** The macOS Keychain. Errors never include the value. */
export function systemKeychain(service = KEYCHAIN_SERVICE): Keychain {
  const wrap = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch {
      throw new KeychainError(`Perch could not ${what} the Keychain. Unlock it and try again.`);
    }
  };
  return {
    async get(name) {
      checkName(name);
      return wrap("read from", () => secrets.get({ service, name }));
    },
    async set(name, value) {
      checkName(name);
      checkValue(value);
      await wrap("write to", () => secrets.set({ service, name, value }));
    },
    async delete(name) {
      checkName(name);
      return wrap("remove from", () => secrets.delete({ service, name }));
    },
  };
}

/** An in-memory keychain for tests, with the same validation as the real one. */
export function memoryKeychain(): Keychain & { names(): string[] } {
  let items = new Map<string, string>();
  return {
    async get(name) {
      checkName(name);
      return items.get(name) ?? null;
    },
    async set(name, value) {
      checkName(name);
      checkValue(value);
      items = new Map(items).set(name, value);
    },
    async delete(name) {
      checkName(name);
      if (!items.has(name)) return false;
      const next = new Map(items);
      next.delete(name);
      items = next;
      return true;
    },
    names: () => [...items.keys()].sort(),
  };
}
