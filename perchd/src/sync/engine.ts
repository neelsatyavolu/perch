/**
 * The sync engine: encrypts local changes and commits them with per-item versions, merges on
 * conflict, and pulls and decrypts what other devices wrote. State is a plain immutable value the
 * caller stores in Perch's encrypted profile store; every call returns a new state.
 */
import { SyncApiError, type SyncApi } from "./api";
import { decryptItem, encryptItem, itemId, type SyncKeys } from "./crypto";
import { merge, type Envelope } from "./merge";
import type { Collection, ItemWrite, ServerItem } from "./types";

export type ItemState = { version: number; keyVersion: number; naturalId: string };
export type SyncState = {
  readonly cursors: Readonly<Partial<Record<Collection, number>>>;
  readonly items: Readonly<Partial<Record<Collection, Readonly<Record<string, ItemState>>>>>;
};
export const emptySyncState: SyncState = { cursors: {}, items: {} };

export type LocalChange = { naturalId: string; updatedAt: number; data?: unknown; deleted?: true };
export type SyncedItem = { naturalId: string; updatedAt: number; deviceId: string; deleted: boolean; data?: unknown };
export type PushResult = { state: SyncState; apply: SyncedItem[]; conflictCopies: SyncedItem[]; failed: { naturalId: string; reason: "quota" | "too_large" }[] };
export type PullResult = { state: SyncState; items: SyncedItem[]; resync: boolean; unreadable: number };
/** No conflict copies: an older copy is an ancestor of whatever was written since, not a rival edit. */
export type ReencryptResult = Pick<PushResult, "state" | "apply" | "failed"> & { moved: number; unreadable: number };

/** The current sync key and any older ones still needed to read items written before a rotation. */
export type Keyring = { current: SyncKeys; byVersion(version: number): SyncKeys | undefined };

export class SyncKeyChangedError extends Error {
  constructor(readonly keyVersion: number) {
    super("The sync key changed on another device. Fetch the new key, then sync again.");
  }
}

const MAX_ATTEMPTS = 4;
const BATCH_ITEMS = 100;
const BATCH_CHARS = 8 * 1024 * 1024;

const toSynced = (e: Envelope): SyncedItem => ({ naturalId: e.id, updatedAt: e.updatedAt, deviceId: e.deviceId, deleted: e.deleted === true, ...(e.data !== undefined ? { data: e.data } : {}) });

function withItem(state: SyncState, collection: Collection, id: string, item: ItemState | null): SyncState {
  const { [id]: _old, ...rest } = state.items[collection] ?? {};
  return { ...state, items: { ...state.items, [collection]: item ? { ...rest, [id]: item } : rest } };
}

type Pending = { id: string; envelope: Envelope; base: number };

export class SyncEngine {
  constructor(private readonly api: SyncApi, private readonly keyring: Keyring, private readonly deviceId: string) {}

  /** Sends local edits. Returns items the caller should apply locally where another device's edit won or was merged in. */
  async push(state: SyncState, collection: Collection, changes: LocalChange[]): Promise<PushResult> {
    const envelopes = changes.map((change): Envelope => ({
      id: change.naturalId, updatedAt: change.updatedAt, deviceId: this.deviceId, ...(change.deleted ? { deleted: true as const } : { data: change.data }),
    }));
    const pending = await this.pending(state, collection, envelopes);
    // A deletion also removes copies still under an older key, so re-encryption cannot revive them.
    const stale = envelopes.some((e) => e.deleted) ? staleIds(state, collection, this.keyring.current.version) : new Map<string, Pending[]>();
    const extra = envelopes.filter((e) => e.deleted).flatMap((e) => (stale.get(e.id) ?? []).map((p) => ({ ...p, envelope: e })));
    return this.send(state, collection, [...pending, ...extra]);
  }

  private pending(state: SyncState, collection: Collection, envelopes: Envelope[]): Promise<Pending[]> {
    const keys = this.keyring.current;
    return Promise.all(envelopes.map(async (envelope) => {
      const id = await itemId(keys, collection, envelope.id);
      return { id, envelope, base: state.items[collection]?.[id]?.version ?? 0 };
    }));
  }

  private async send(state: SyncState, collection: Collection, initial: Pending[]): Promise<PushResult> {
    const keys = this.keyring.current;
    let current = state;
    let pending = initial;
    const result: Omit<PushResult, "state"> = { apply: [], conflictCopies: [], failed: [] };
    for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length; attempt++) {
      const retry: Pending[] = [];
      for (const batch of await this.batches(collection, pending.filter((p) => !(p.envelope.deleted && p.base === 0)))) {
        const results = await this.api.commit(collection, batch.writes);
        for (const [i, res] of results.entries()) {
          const item = batch.items[i]!;
          if (res.status === "ok") current = withItem(current, collection, item.id, { version: res.version, keyVersion: keys.version, naturalId: item.envelope.id });
          else if (res.status === "stale_key") throw new SyncKeyChangedError(res.keyVersion);
          else if (res.status === "quota" || res.status === "too_large") result.failed.push({ naturalId: item.envelope.id, reason: res.status });
          else {
            const resolved = await this.resolve(collection, item, res.current);
            current = resolved.state(current);
            if (resolved.apply) result.apply.push(toSynced(resolved.apply));
            if (resolved.copy) result.conflictCopies.push(toSynced(resolved.copy));
            if (resolved.retry) retry.push(resolved.retry);
          }
        }
      }
      pending = retry;
    }
    return { state: current, ...result };
  }

  /** Works out a conflict: adopt the stored item, or write the merged one on top of it. */
  private async resolve(collection: Collection, item: Pending, stored: ServerItem | null) {
    if (!stored) return { state: (s: SyncState) => withItem(s, collection, item.id, null), retry: { ...item, base: 0 } };
    const remote = stored.deleted
      ? { id: item.envelope.id, updatedAt: stored.updatedAt, deviceId: "", deleted: true as const }
      : await this.open(collection, stored);
    const known = { version: stored.version, keyVersion: stored.keyVersion, naturalId: item.envelope.id };
    const state = (s: SyncState) => withItem(s, collection, item.id, known);
    // Written with a key this device does not have yet: never overwrite what it cannot read.
    if (!remote) throw new SyncKeyChangedError(stored.keyVersion);
    const { winner, conflictCopy } = merge(collection, item.envelope, remote);
    if (winner === remote) return { state, apply: remote, copy: conflictCopy };
    const merged = winner === item.envelope ? undefined : winner;
    return { state, apply: merged, copy: conflictCopy, retry: { id: item.id, envelope: winner, base: stored.version } };
  }

  private async batches(collection: Collection, items: Pending[]) {
    const keys = this.keyring.current;
    const out: { items: Pending[]; writes: ItemWrite[] }[] = [];
    let chars = 0;
    for (const item of items) {
      const write: ItemWrite = item.envelope.deleted
        ? { id: item.id, baseVersion: item.base, deleted: true }
        : { id: item.id, baseVersion: item.base, keyVersion: keys.version, ciphertext: await encryptItem(keys, collection, item.id, item.base + 1, JSON.stringify(item.envelope)) };
      const size = "ciphertext" in write ? write.ciphertext.length : 0;
      const last = out.at(-1);
      if (!last || last.writes.length >= BATCH_ITEMS || chars + size > BATCH_CHARS) {
        out.push({ items: [item], writes: [write] });
        chars = size;
      } else {
        out[out.length - 1] = { items: [...last.items, item], writes: [...last.writes, write] };
        chars += size;
      }
    }
    return out;
  }

  /** Decrypts a stored item, or returns null if this device cannot read it (an unknown key version). */
  private async open(collection: Collection, stored: ServerItem): Promise<Envelope | null> {
    const keys = this.keyring.byVersion(stored.keyVersion);
    if (!keys) return null;
    const ciphertext = stored.ciphertext ?? (await this.api.blob(collection, stored.id));
    const envelope = JSON.parse(await decryptItem(keys, collection, stored.id, stored.version, ciphertext)) as Envelope;
    if (typeof envelope.id !== "string" || typeof envelope.updatedAt !== "number") throw new Error("A synced item is malformed");
    return envelope;
  }

  /**
   * Opens an item for a pull. "changed" means it was rewritten after the listing (a newer version
   * comes later); null means this device can never read it. Network errors are thrown, so the
   * cursor never moves past an item that might still be readable.
   */
  private async tryOpen(collection: Collection, stored: ServerItem): Promise<Envelope | null | "changed"> {
    if (stored.keyVersion > this.keyring.current.version) throw new SyncKeyChangedError(stored.keyVersion);
    if (!this.keyring.byVersion(stored.keyVersion)) return null;
    try {
      return await this.open(collection, stored);
    } catch (error) {
      if (error instanceof SyncApiError) {
        if (error.status === 404) return "changed";
        throw error;
      }
      return null;
    }
  }

  /** True when a deleted id's real item lives on under the current key (it was re-encrypted). */
  private async movedOn(state: SyncState, collection: Collection, naturalId: string, deletedId: string): Promise<boolean> {
    const id = await itemId(this.keyring.current, collection, naturalId);
    return id !== deletedId && state.items[collection]?.[id] !== undefined;
  }

  /**
   * Fetches and decrypts everything other devices changed since the last pull. Throws
   * SyncKeyChangedError, without moving the cursor, at an item written with a key this device
   * does not have yet: load the new key and pull again.
   */
  async pull(state: SyncState, collection: Collection): Promise<PullResult> {
    let current = state;
    let after = state.cursors[collection] ?? 0;
    let resync = false;
    let unreadable = 0;
    const items: SyncedItem[] = [];
    for (;;) {
      let page;
      try {
        page = await this.api.changes(collection, after);
      } catch (error) {
        if (!(error instanceof SyncApiError) || error.code !== "resync" || resync) throw error;
        resync = true;
        after = 0;
        current = { ...current, items: { ...current.items, [collection]: {} } };
        continue;
      }
      for (const stored of page.items) {
        const known = current.items[collection]?.[stored.id];
        if (stored.deleted) {
          current = withItem(current, collection, stored.id, null);
          if (known && !(await this.movedOn(current, collection, known.naturalId, stored.id))) {
            items.push({ naturalId: known.naturalId, updatedAt: stored.updatedAt, deviceId: "", deleted: true });
          }
          continue;
        }
        const envelope = await this.tryOpen(collection, stored);
        if (envelope === "changed") continue;
        if (!envelope) {
          unreadable++;
          continue;
        }
        current = withItem(current, collection, stored.id, { version: stored.version, keyVersion: stored.keyVersion, naturalId: envelope.id });
        items.push(toSynced(envelope));
      }
      after = page.next;
      current = { ...current, cursors: { ...current.cursors, [collection]: after } };
      if (!page.more) break;
    }
    return { state: current, items, resync, unreadable };
  }

  /**
   * After a key rotation: moves every item still under an older key to the current one. Each is
   * written under its new id (merged with any edit already made there), then its old copy is
   * deleted. Safe to run again; anything that changed meanwhile moves on the next run.
   */
  async reencrypt(state: SyncState, collection: Collection): Promise<ReencryptResult> {
    const { old, unreadable } = await this.olderItems(collection);
    let current = state;
    let moved = 0;
    const result: Pick<PushResult, "apply" | "failed"> = { apply: [], failed: [] };
    const groups = [...old.values()];
    for (let i = 0; i < groups.length; i += BATCH_ITEMS) {
      const chunk = groups.slice(i, i + BATCH_ITEMS);
      // Base 0 even where this device knows the new id: an older copy must merge with what is there, never overwrite it.
      const fresh = (await this.pending(current, collection, chunk.map((g) => g.envelope))).map((p) => ({ ...p, base: 0 }));
      const pushed = await this.send(current, collection, fresh);
      current = pushed.state;
      result.apply.push(...pushed.apply);
      result.failed.push(...pushed.failed);
      const kept = new Set(pushed.failed.map((f) => f.naturalId));
      const removals = chunk.filter((g) => !kept.has(g.envelope.id)).flatMap((g) => g.copies);
      for (let j = 0; j < removals.length; j += BATCH_ITEMS) {
        const slice = removals.slice(j, j + BATCH_ITEMS);
        const results = await this.api.commit(collection, slice.map((r) => ({ id: r.id, baseVersion: r.version, deleted: true as const })));
        for (const [k, res] of results.entries()) {
          if (res.status !== "ok") continue;
          current = withItem(current, collection, slice[k]!.id, null);
          moved++;
        }
      }
    }
    return { state: current, moved, unreadable, ...result };
  }

  /** Every live item under an older key, grouped by real id (one per id, merged across versions). */
  private async olderItems(collection: Collection) {
    const version = this.keyring.current.version;
    const old = new Map<string, { envelope: Envelope; copies: ServerItem[] }>();
    let unreadable = 0;
    for (let after = 0, more = true; more; ) {
      const page = await this.api.changes(collection, after);
      for (const stored of page.items) {
        if (stored.deleted || stored.keyVersion === version) continue;
        const envelope = await this.tryOpen(collection, stored);
        if (envelope === "changed") continue;
        if (!envelope) {
          unreadable++;
          continue;
        }
        const seen = old.get(envelope.id);
        old.set(envelope.id, seen
          ? { envelope: merge(collection, seen.envelope, envelope).winner, copies: [...seen.copies, stored] }
          : { envelope, copies: [stored] });
      }
      after = page.next;
      more = page.more;
    }
    return { old, unreadable };
  }
}

/** Ids this device knows under an older key, by real id. */
function staleIds(state: SyncState, collection: Collection, version: number): Map<string, Pending[]> {
  const out = new Map<string, Pending[]>();
  for (const [id, item] of Object.entries(state.items[collection] ?? {})) {
    if (item.keyVersion === version) continue;
    out.set(item.naturalId, [...(out.get(item.naturalId) ?? []), { id, envelope: { id: item.naturalId, updatedAt: 0, deviceId: "" }, base: item.version }]);
  }
  return out;
}
