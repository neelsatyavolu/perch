/**
 * Where Perch keeps secrets (spec 11.1): the macOS Keychain, called in-process through
 * Security.framework (see mac-security.ts) so each item's access list trusts only Perch. Values
 * are stored base64-encoded. Tests use MemoryKeychain, or MacKeychain on a throwaway keychain file.
 */

import type { Pointer } from "bun:ffi";
import { addPassword, deletePassword, readPassword, writePassword } from "./mac-security";
import { ownService } from "./service-name";

export interface SecretStore {
  get(account: string): Promise<string | null>;
  /** Creates or replaces the item. */
  set(account: string, value: string): Promise<void>;
  /** Creates the item only if it does not exist yet; returns false, changing nothing, if it does. */
  add(account: string, value: string): Promise<boolean>;
  delete(account: string): Promise<void>;
}

/** Account names are built by Perch (like mcp/github/env/TOKEN); anything else is refused. */
const ACCOUNT = /^[A-Za-z0-9._@:/+-]{1,200}$/;
const SERVICE = /^[A-Za-z0-9 ._-]{1,64}$/;

function checkAccount(account: string): void {
  if (!ACCOUNT.test(account)) throw new Error(`"${account.slice(0, 40)}" is not a valid Keychain account name`);
}

export class MemoryKeychain implements SecretStore {
  private items: ReadonlyMap<string, string> = new Map();

  async get(account: string): Promise<string | null> {
    return this.items.get(account) ?? null;
  }
  async set(account: string, value: string): Promise<void> {
    checkAccount(account);
    this.items = new Map([...this.items, [account, value]]);
  }
  async add(account: string, value: string): Promise<boolean> {
    checkAccount(account);
    if (this.items.has(account)) return false;
    this.items = new Map([...this.items, [account, value]]);
    return true;
  }
  async delete(account: string): Promise<void> {
    this.items = new Map([...this.items].filter(([k]) => k !== account));
  }
  /** Account names only, for tests that check where secrets went. */
  accounts(): string[] {
    return [...this.items.keys()];
  }
}

const encode = (value: string) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8");

export class MacKeychain implements SecretStore {
  private readonly service: string;
  private readonly keychain: Pointer | null;

  /** keychain: a keychain file opened by mac-security (tests); by default the login keychain. */
  constructor(opts: { service?: string; keychain?: Pointer } = {}) {
    const service = opts.service ?? "Perch";
    if (!SERVICE.test(service)) throw new Error("not a valid Keychain service name");
    this.service = ownService(service);
    this.keychain = opts.keychain ?? null;
  }

  async get(account: string): Promise<string | null> {
    checkAccount(account);
    const raw = readPassword(this.keychain, this.service, account);
    return raw === null ? null : Buffer.from(raw.toString("utf8").trim(), "base64").toString("utf8");
  }

  async set(account: string, value: string): Promise<void> {
    checkAccount(account);
    writePassword(this.keychain, this.service, account, encode(value));
  }

  async add(account: string, value: string): Promise<boolean> {
    checkAccount(account);
    return addPassword(this.keychain, this.service, account, encode(value));
  }

  async delete(account: string): Promise<void> {
    checkAccount(account);
    deletePassword(this.keychain, this.service, account);
  }
}

/** The same store, kept in the profile's sealed secrets file (plan 3b, task 3) instead of the Keychain. */
export function sealedSecretStore(secrets: import("./sealed-secrets").SealedSecrets): SecretStore {
  return {
    get: (account) => secrets.get(account),
    async set(account, value) {
      checkAccount(account);
      await secrets.set(account, value);
    },
    async add(account, value) {
      checkAccount(account);
      return secrets.add(account, value);
    },
    async delete(account) {
      await secrets.delete(account);
    },
  };
}
