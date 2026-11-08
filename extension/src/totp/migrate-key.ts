/**
 * Moves records made under a key kept in IndexedDB (development profiles) to Perch's key. Every
 * record is re-encrypted and written before the old key is deleted, so a crash at any point leaves
 * each record readable under one of the two keys; running again finishes the job.
 */

import { decrypt, encrypt, type KeyStore, type RecordStore, type StoredEntry } from "./vault";

export type LegacyKeyStore = { get(): Promise<CryptoKey | null>; remove(): Promise<void> };

/** Returns how many records were re-encrypted. Throws, changing nothing, if a record opens under neither key. */
export async function migrateKey(legacy: LegacyKeyStore, target: KeyStore, records: RecordStore): Promise<number> {
  const old = await legacy.get();
  if (!old) return 0;
  const key = await target.get();
  if (!key) throw new Error("Perch's key is not available.");
  const stored = await records.read();
  const moved = await Promise.all(stored.map((entry) => underKey(entry, key, old)));
  const changed = moved.filter((entry, i) => entry !== stored[i]).length;
  if (changed > 0) await records.write(moved);
  await legacy.remove();
  return changed;
}

/** The record as stored under `key`: unchanged if it already is, re-encrypted from `old` if not. */
async function underKey(entry: StoredEntry, key: CryptoKey, old: CryptoKey): Promise<StoredEntry> {
  const already = await decrypt(key, entry).then(
    () => true,
    () => false,
  );
  if (already) return entry;
  return encrypt(key, await decrypt(old, entry));
}
