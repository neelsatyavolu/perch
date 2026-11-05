/**
 * The authenticator's store. Each account record (issuer, account, site, secret) is encrypted whole
 * with AES-256-GCM under one non-extractable key, with the record id as associated data so records
 * cannot be swapped. The key lives in IndexedDB as a CryptoKey that script cannot export; records
 * live in chrome.storage.local, which Chromium never syncs. In the Perch build the key moves behind
 * the Keychain-wrapped profile key (spec 11.1).
 */

import { base32Decode } from "./base32";
import type { Account } from "./otpauth";
import { totp } from "./totp";

export type StoredEntry = { readonly id: string; readonly iv: string; readonly data: string };
export type VaultEntry = Account & { readonly id: string; readonly site: string | null; readonly added: number };

export type KeyStore = { get(): Promise<CryptoKey | null>; put(key: CryptoKey): Promise<void> };
export type RecordStore = { read(): Promise<readonly StoredEntry[]>; write(entries: readonly StoredEntry[]): Promise<void> };

const UNREADABLE = "Saved codes could not be read on this device. They may have been changed or copied from another profile.";

export class Vault {
  constructor(
    private readonly keys: KeyStore,
    private readonly records: RecordStore,
  ) {}

  async list(): Promise<VaultEntry[]> {
    const stored = await this.records.read();
    if (stored.length === 0) return [];
    const key = await this.keys.get();
    if (!key) throw new Error(UNREADABLE);
    return Promise.all(stored.map((entry) => decrypt(key, entry)));
  }

  async add(account: Account, site: string | null): Promise<VaultEntry> {
    const entry: VaultEntry = { ...account, id: crypto.randomUUID(), site, added: Date.now() };
    const stored = await encrypt(await this.key(), entry);
    await this.records.write([...(await this.records.read()), stored]);
    return entry;
  }

  async rename(id: string, names: { issuer: string; account: string; site?: string | null }): Promise<void> {
    const entries = await this.list();
    const target = entries.find((e) => e.id === id);
    if (!target) throw new Error("That code is no longer saved.");
    const key = await this.key();
    const updated: VaultEntry = {
      ...target,
      issuer: names.issuer.trim().slice(0, 200),
      account: names.account.trim().slice(0, 200),
      site: names.site === undefined ? target.site : names.site,
    };
    const stored = await this.records.read();
    const replacement = await encrypt(key, updated);
    await this.records.write(stored.map((s) => (s.id === id ? replacement : s)));
  }

  async remove(id: string): Promise<void> {
    const stored = await this.records.read();
    await this.records.write(stored.filter((s) => s.id !== id));
  }

  async code(id: string, time = Date.now() / 1000): Promise<string> {
    const entry = (await this.list()).find((e) => e.id === id);
    if (!entry) throw new Error("That code is no longer saved.");
    return codeFor(entry, time);
  }

  private async key(): Promise<CryptoKey> {
    const existing = await this.keys.get();
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await this.keys.put(key);
    return key;
  }
}

export function codeFor(entry: Account, time = Date.now() / 1000): Promise<string> {
  return totp(base32Decode(entry.secret), { time, period: entry.period, digits: entry.digits, algorithm: entry.algorithm });
}

async function encrypt(key: CryptoKey, entry: VaultEntry): Promise<StoredEntry> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(entry));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(entry.id) }, key, plain);
  return { id: entry.id, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

async function decrypt(key: CryptoKey, stored: StoredEntry): Promise<VaultEntry> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(stored.iv) as BufferSource, additionalData: new TextEncoder().encode(stored.id) },
      key,
      fromBase64(stored.data) as BufferSource,
    );
    const entry = JSON.parse(new TextDecoder().decode(plain)) as VaultEntry;
    if (entry.id !== stored.id) throw new Error("id mismatch");
    return entry;
  } catch {
    throw new Error(UNREADABLE);
  }
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
