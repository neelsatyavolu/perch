import type { AppEnv } from "./env";
import { logEvent } from "./log";

const DAY = 24 * 60 * 60 * 1000;
/** Deletions are kept this long so devices that were away can still learn about them. */
export const TOMBSTONE_DAYS = 90;

/** Daily: drop expired sign-in, challenge, pairing and session rows, and old deletion markers. */
export async function cleanup(env: AppEnv, now: number): Promise<void> {
  const before = now - TOMBSTONE_DAYS * DAY;
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM email_requests WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM confirmations WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM pairings WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    // Remember the newest purged deletion per account; a device behind that point must resync.
    env.DB.prepare(
      `UPDATE accounts SET purge_seq = MAX(purge_seq, (SELECT MAX(seq) FROM items WHERE account_id = accounts.id AND deleted = 1 AND updated_at <= ?1))
       WHERE EXISTS (SELECT 1 FROM items WHERE account_id = accounts.id AND deleted = 1 AND updated_at <= ?1)`,
    ).bind(before),
    env.DB.prepare("DELETE FROM items WHERE deleted = 1 AND updated_at <= ?").bind(before),
  ]);
  logEvent("cleanup", { count: results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0) });
}
