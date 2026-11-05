/** Browser-side storage for the vault: the key in IndexedDB, the encrypted records in chrome.storage.local. */

/** Set by the build: true only for development and test builds (`bun run build -- --profile-key`). */
declare const PERCH_PROFILE_KEY: boolean | undefined;

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

export const idbKeyStore: KeyStore = {
  get: async () => (await withStore<CryptoKey | undefined>("readonly", (s) => s.get(KEY_ID))) ?? null,
  put: async (key) => void (await withStore("readwrite", (s) => s.put(key, KEY_ID))),
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

/**
 * The vault, or null when this build has no safe place for its key. A key in IndexedDB sits in the
 * same profile folder as the records, which breaks the rule that secrets live in the Keychain, so
 * release builds turn the authenticator off until the Keychain wrap (spec 11.1) exists.
 */
export function browserVault(): Vault | null {
  const profileKey = typeof PERCH_PROFILE_KEY !== "undefined" && PERCH_PROFILE_KEY === true;
  return profileKey ? new Vault(idbKeyStore, storageRecords) : null;
}

export const AUTHENTICATOR_OFF = "The authenticator turns on once Perch can keep its key in the macOS Keychain. This build cannot yet, so it saves no codes.";
