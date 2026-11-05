/**
 * How two devices' edits to the same item are combined when a write conflicts. Every item's
 * plaintext is an Envelope; the rule depends on the collection.
 */
import type { Collection } from "./types";

export type Envelope = { id: string; updatedAt: number; deviceId: string; deleted?: true; data?: unknown };
export type Merged = { winner: Envelope; conflictCopy?: Envelope };

/** Newer edit wins; equal times break by device id so every device picks the same one. */
function newer(a: Envelope, b: Envelope): [Envelope, Envelope] {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? [a, b] : [b, a];
  return a.deviceId >= b.deviceId ? [a, b] : [b, a];
}

export type HistoryEntry = { url: string; title?: string; visits: number[] };

const isHistory = (data: unknown): data is HistoryEntry =>
  typeof data === "object" && data !== null && typeof (data as HistoryEntry).url === "string" && Array.isArray((data as HistoryEntry).visits);

/** History never loses a visit: visits from both sides are kept, newest title wins. */
function mergeHistory(local: Envelope, remote: Envelope): Envelope {
  const [win, lose] = newer(local, remote);
  if (!isHistory(local.data) || !isHistory(remote.data)) return win;
  const visits = [...new Set([...local.data.visits, ...remote.data.visits])].sort((a, b) => a - b);
  const winData = win.data as HistoryEntry;
  const loseData = lose.data as HistoryEntry;
  return { ...win, data: { ...winData, title: winData.title ?? loseData.title, visits } };
}

const keepsConflictCopies = new Set<Collection>(["memory", "skills"]);

/**
 * Merges the local edit with what another device already stored. Deleting wins over an older edit
 * and loses to a newer one. Memory and skills keep the losing text as a conflict copy, because
 * a lost paragraph of memory or a skill is worse than a duplicate the person can tidy.
 */
export function merge(collection: Collection, local: Envelope, remote: Envelope): Merged {
  if (collection === "history" && !local.deleted && !remote.deleted) return { winner: mergeHistory(local, remote) };
  const [winner, loser] = newer(local, remote);
  if (keepsConflictCopies.has(collection) && !loser.deleted && !winner.deleted && JSON.stringify(loser.data) !== JSON.stringify(winner.data)) {
    return { winner, conflictCopy: loser };
  }
  return { winner };
}
