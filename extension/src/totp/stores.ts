/**
 * Browser-side storage for the vault: the key from Perch over native messaging (or, in unpacked
 * development installs only, in IndexedDB), the encrypted records in chrome.storage.local.
 */

import { migrateKey, type LegacyKeyStore } from "./migrate-key";
import { nativeKeyStore, type SendNative } from "./native-key";
import { Vault, type KeyStore, type RecordStore, type StoredEntry } from "./vault";

const DB = "perch-vault";
const STORE = "keys";
const KEY_ID = "totp";
const RECORDS_KEY = "totp";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB could not be opened"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

export const idbKeyStore: KeyStore & LegacyKeyStore = {
  get: async () => (await withStore<CryptoKey | undefined>("readonly", (s) => s.get(KEY_ID))) ?? null,
  put: async (key) => void (await withStore("readwrite", (s) => s.put(key, KEY_ID))),
  remove: async () => void (await withStore("readwrite", (s) => s.delete(KEY_ID))),
};

export const storageRecords: RecordStore = {
  read: async () => {
    const value = (await chrome.storage.local.get(RECORDS_KEY))[RECORDS_KEY];
    return Array.isArray(value) ? value.filter(isStoredEntry) : [];
  },
  write: (entries) => chrome.storage.local.set({ [RECORDS_KEY]: entries }),
};

function isStoredEntry(value: unknown): value is StoredEntry {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v.id === "string" && typeof v.iv === "string" && typeof v.data === "string";
}

const sendNative: SendNative = (host, message) =>
  typeof chrome !== "undefined" && chrome.runtime?.sendNativeMessage
    ? chrome.runtime.sendNativeMessage(host, message)
    : Promise.reject(new Error("native messaging is not available"));

/** One per extension context, so the key is asked for once and then kept in memory. */
const perchKey = nativeKeyStore(sendNative);

/** Unpacked installs (development, Chrome for Testing) only; Perch's component extension never is one. */
async function isUnpacked(): Promise<boolean> {
  try {
    return (await chrome.management.getSelf()).installType === "development";
  } catch {
    return false;
  }
}

export type OpenVault = { readonly vault: Vault; readonly keyInProfile: boolean };

export type VaultDeps = {
  readonly keys?: KeyStore;
  readonly legacy?: KeyStore & LegacyKeyStore;
  readonly records?: RecordStore;
  readonly unpacked?: () => Promise<boolean>;
};

/**
 * The vault under Perch's key whenever the browser hands it over, after moving any records made
 * under a development key. Without Perch's key, an unpacked install keeps its key in IndexedDB (in
 * the profile folder next to the records, so for development and tests only); anything else gets
 * null and the authenticator stays off.
 */
export async function browserVault(deps: VaultDeps = {}): Promise<OpenVault | null> {
  const keys = deps.keys ?? perchKey;
  const legacy = deps.legacy ?? idbKeyStore;
  const records = deps.records ?? storageRecords;
  if (await answers(keys)) {
    // A failed move leaves both keys and every record in place; the vault then reports unreadable
    // records, and the next open tries the move again.
    await migrateKey(legacy, keys, records).catch(() => console.error("Perch authenticator: saved codes could not be moved to Perch's key yet."));
    return { vault: new Vault(keys, records), keyInProfile: false };
  }
  return (await (deps.unpacked ?? isUnpacked)()) ? { vault: new Vault(legacy, records), keyInProfile: true } : null;
}

async function answers(keys: KeyStore): Promise<boolean> {
  try {
    return (await keys.get()) !== null;
  } catch {
    return false;
  }
}

export const AUTHENTICATOR_OFF = "The authenticator needs Perch's own key, and this browser does not provide it, so it saves no codes.";
