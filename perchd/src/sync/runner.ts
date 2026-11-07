/**
 * One sync pass over every collection a device syncs. Each collection has an adapter over its local
 * store (bookmarks, history, settings, memory, skills, open tabs): it hands over local edits since
 * the last pass and applies what other devices changed. The pass pulls first (so pushes conflict
 * less), applies, then pushes. When another device has changed the sync key the pass stops before
 * reading or writing anything under the old key, and says so; the caller loads the new keys
 * (loadSyncKeys), builds a new engine and runs again. Local edits stay queued until pushed.
 */
import { SyncKeyChangedError, type LocalChange, type ReencryptResult, type SyncEngine, type SyncedItem, type SyncState } from "./engine";
import type { Collection } from "./types";

export type SyncAdapter = {
  readonly collection: Collection;
  /** Local edits not yet pushed. */
  changes(): Promise<LocalChange[]>;
  /** These edits reached the server (or were merged there); the rest stay queued. */
  pushed(changes: LocalChange[]): Promise<void>;
  /** Items other devices changed, and conflict copies to keep beside the winner. */
  apply(items: SyncedItem[], conflictCopies: SyncedItem[]): Promise<void>;
};

export type SyncFailure = { collection: Collection; naturalId: string; reason: "quota" | "too_large" };
/** `stopped`: a company policy turned sync off during the pass, which ended before the next collection. */
export type SyncRun = { state: SyncState; failed: SyncFailure[]; unreadable: number; keyChanged?: number; stopped?: "policy" };

/** `allowed` is asked before every collection, so turning sync off by policy stops a pass in progress. */
export async function syncOnce(engine: SyncEngine, state: SyncState, adapters: readonly SyncAdapter[], allowed: () => boolean = () => true): Promise<SyncRun> {
  let current = state;
  const failed: SyncFailure[] = [];
  let unreadable = 0;
  for (const adapter of adapters) {
    if (!allowed()) return { state: current, failed, unreadable, stopped: "policy" };
    try {
      const pulled = await engine.pull(current, adapter.collection);
      current = pulled.state;
      unreadable += pulled.unreadable;
      if (pulled.items.length) await adapter.apply(pulled.items, []);
      const changes = await adapter.changes();
      if (!changes.length) continue;
      const pushed = await engine.push(current, adapter.collection, changes);
      current = pushed.state;
      if (pushed.apply.length || pushed.conflictCopies.length) await adapter.apply(pushed.apply, pushed.conflictCopies);
      const kept = new Set(pushed.failed.map((f) => f.naturalId));
      await adapter.pushed(changes.filter((c) => !kept.has(c.naturalId)));
      failed.push(...pushed.failed.map((f) => ({ collection: adapter.collection, ...f })));
    } catch (error) {
      if (error instanceof SyncKeyChangedError) return { state: current, failed, unreadable, keyChanged: error.keyVersion };
      throw error;
    }
  }
  return { state: current, failed, unreadable };
}

/** After this device rotated the key (or learned of a rotation): moves every collection's items to it. */
export async function reencryptAll(engine: SyncEngine, state: SyncState, collections: readonly Collection[]): Promise<Omit<ReencryptResult, "apply"> & { apply: Partial<Record<Collection, SyncedItem[]>> }> {
  let current = state;
  let moved = 0;
  let unreadable = 0;
  const failed: ReencryptResult["failed"] = [];
  const apply: Partial<Record<Collection, SyncedItem[]>> = {};
  for (const collection of collections) {
    const result = await engine.reencrypt(current, collection);
    current = result.state;
    moved += result.moved;
    unreadable += result.unreadable;
    failed.push(...result.failed);
    if (result.apply.length) apply[collection] = result.apply;
  }
  return { state: current, moved, unreadable, failed, apply };
}
