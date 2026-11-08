/**
 * Moves secrets out of the seven old Keychain adapters into the profile's sealed secrets files
 * (plan 3b, task 3). Per store: copy every item that is present, mark the store `copied-v1`,
 * delete the old items, then mark it `migrated-v1`. A crash anywhere leaves a state the next run
 * finishes without copying twice; an item already written by the new store is never replaced.
 * Values are never logged.
 */

import type { KeyStoreName } from "./key-channel";
import type { SealedSecrets } from "./sealed-secrets";

/** One old Keychain store, seen through its own adapter. `name` is the new store's name for an item. */
export type LegacySource = {
  /** Names the old store in the marks; unique among sources. */
  readonly id: string;
  readonly store: KeyStoreName;
  /** The old items that may exist: the new name, and how to reach the old item. */
  items(): Promise<ReadonlyArray<LegacyItem>>;
};

export type LegacyItem = {
  readonly name: string;
  read(): Promise<string | null>;
  remove(): Promise<void>;
};

export type MigrationResult = { id: string; store: KeyStoreName; moved: number; removed: number; skipped: boolean };

export const COPIED = "copied-v1";
export const MIGRATED = "migrated-v1";

async function migrateOne(source: LegacySource, target: SealedSecrets): Promise<MigrationResult> {
  const copied = `${COPIED}:${source.id}`;
  const migrated = `${MIGRATED}:${source.id}`;
  if (await target.marked(migrated)) return { id: source.id, store: source.store, moved: 0, removed: 0, skipped: true };
  const items = await source.items();
  let moved = 0;
  if (!(await target.marked(copied))) {
    for (const item of items) {
      const value = await item.read();
      if (value === null) continue;
      if (await target.add(item.name, value)) moved++;
    }
    await target.mark(copied);
  }
  let removed = 0;
  for (const item of items) {
    await item.remove();
    removed++;
  }
  await target.mark(migrated);
  return { id: source.id, store: source.store, moved, removed, skipped: false };
}

/**
 * Runs every source in order. Stops at the first failure (the error names the store, not a value),
 * so the next launch resumes from that store.
 */
export async function migrateLegacy(sources: readonly LegacySource[], target: (store: KeyStoreName) => SealedSecrets): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  for (const source of sources) {
    try {
      results.push(await migrateOne(source, target(source.store)));
    } catch (error) {
      throw new Error(`moving the ${source.id} secrets out of the Keychain stopped: ${(error as Error).message}`);
    }
  }
  return results;
}
