import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "./env";
import { quotaBytes } from "./env";
import { fromBase64Url } from "./crypto";
import { base64url, check, HttpError, readJson } from "./http";
import { requireBrowser } from "./auth/session";
import { limit, RULES } from "./ratelimit";
import { keyVersion } from "./keys";

/**
 * End-to-end encrypted item sync. Items are opaque ciphertext with a client-made id. Each write
 * names the version it was based on; it applies only if that is still the stored version, and the
 * new version is always base + 1 (clients bind the version into the ciphertext, so the server
 * cannot roll an item back unnoticed). Small items live in D1, large ones in R2.
 */
export const syncRoutes = new Hono<HonoEnv>();
syncRoutes.use(requireBrowser);

export const COLLECTIONS = ["bookmarks", "history", "settings", "memory", "skills", "tabs", "chats", "artifacts"] as const;
const collectionSchema = z.enum(COLLECTIONS);
const itemIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/, "is not a valid item id");
export const MAX_ITEM_BYTES = 4 * 1024 * 1024;
const INLINE_LIMIT = 64 * 1024;
const MAX_BODY = 12 * 1024 * 1024;
const PAGE = 500;

const writeSchema = z.union([
  z.object({ id: itemIdSchema, baseVersion: z.number().int().min(0), keyVersion: z.number().int().min(1), ciphertext: base64url(Math.ceil((MAX_ITEM_BYTES * 4) / 3) + 4) }).strict(),
  z.object({ id: itemIdSchema, baseVersion: z.number().int().min(1), deleted: z.literal(true) }).strict(),
]);
type Write = z.infer<typeof writeSchema>;

type ItemRow = { id: string; version: number; key_version: number; seq: number; size: number; deleted: number; data: string | null; blob_key: string | null; updated_at: number };

const itemOut = (row: ItemRow) => ({
  id: row.id,
  version: row.version,
  keyVersion: row.key_version,
  seq: row.seq,
  size: row.size,
  deleted: row.deleted === 1,
  updatedAt: row.updated_at,
  ...(row.data !== null ? { ciphertext: row.data } : {}),
  ...(row.blob_key !== null ? { blob: true } : {}),
});

const blobKey = (accountId: string, collection: string, id: string, version: number) => `items/${accountId}/${collection}/${id}/${version}`;

syncRoutes.post("/:collection/commit", limit(RULES.syncWrite, (c) => c.var.auth.accountId), async (c) => {
  const collection = check(collectionSchema, c.req.param("collection"));
  const { items } = await readJson(c, z.object({ items: z.array(writeSchema).min(1).max(100) }).strict(), MAX_BODY);
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new HttpError(400, "duplicate_item", "Each item may appear once per commit.");
  const results = [];
  for (const item of items) results.push(await commitOne(c.env, c.var.auth.accountId, collection, item, c.var.deps.now()));
  return c.json({ results });
});

async function commitOne(env: AppEnv, accountId: string, collection: string, item: Write, now: number) {
  const current = await readItem(env, accountId, collection, item.id);
  const conflict = (row: ItemRow | null) => ({ id: item.id, status: "conflict" as const, current: row ? itemOut(row) : null });
  if ((current?.version ?? 0) !== item.baseVersion) return conflict(current);

  const ciphertext = "ciphertext" in item ? item.ciphertext : null;
  const deleted = ciphertext === null;
  const bytes = ciphertext === null ? null : fromBase64Url(ciphertext);
  const size = bytes?.length ?? 0;
  if (size > MAX_ITEM_BYTES) return { id: item.id, status: "too_large" as const };
  const account = await env.DB.prepare("SELECT bytes_used, key_version FROM accounts WHERE id = ?").bind(accountId).first<{ bytes_used: number; key_version: number }>();
  if (!account) throw new HttpError(401, "signed_out", "Sign in to Perch again.");
  if ("keyVersion" in item && item.keyVersion !== account.key_version) return { id: item.id, status: "stale_key" as const, keyVersion: account.key_version };
  if (account.bytes_used + size - (current?.size ?? 0) > quotaBytes(env)) return { id: item.id, status: "quota" as const };

  const version = item.baseVersion + 1;
  const key = bytes && size > INLINE_LIMIT ? blobKey(accountId, collection, item.id, version) : null;
  if (key && bytes) await env.BLOBS.put(key, bytes);
  const data = bytes && !key ? ciphertext : null;
  const kv = "keyVersion" in item ? item.keyVersion : account.key_version;
  const same = "COALESCE((SELECT version FROM items WHERE account_id = ?1 AND collection = ?2 AND id = ?3), 0) = ?4";
  const [, written] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET seq = seq + 1,
       bytes_used = bytes_used + ?5 - COALESCE((SELECT size FROM items WHERE account_id = ?1 AND collection = ?2 AND id = ?3), 0)
       WHERE id = ?1 AND ${same}`,
    ).bind(accountId, collection, item.id, item.baseVersion, size),
    env.DB.prepare(
      `INSERT INTO items (account_id, collection, id, version, key_version, seq, size, deleted, data, blob_key, updated_at)
       SELECT ?1, ?2, ?3, ?4 + 1, ?6, (SELECT seq FROM accounts WHERE id = ?1), ?5, ?7, ?8, ?9, ?10 WHERE ${same}
       ON CONFLICT(account_id, collection, id) DO UPDATE SET version = excluded.version, key_version = excluded.key_version,
       seq = excluded.seq, size = excluded.size, deleted = excluded.deleted, data = excluded.data, blob_key = excluded.blob_key,
       updated_at = excluded.updated_at`,
    ).bind(accountId, collection, item.id, item.baseVersion, size, kv, deleted ? 1 : 0, data, key, now),
  ]);
  if (written?.meta.changes !== 1) {
    if (key) await env.BLOBS.delete(key);
    return conflict(await readItem(env, accountId, collection, item.id));
  }
  if (current?.blob_key) await env.BLOBS.delete(current.blob_key);
  const saved = await readItem(env, accountId, collection, item.id);
  return { id: item.id, status: "ok" as const, version, seq: saved?.seq ?? 0 };
}

const readItem = (env: AppEnv, accountId: string, collection: string, id: string) =>
  env.DB.prepare("SELECT id, version, key_version, seq, size, deleted, data, blob_key, updated_at FROM items WHERE account_id = ? AND collection = ? AND id = ?")
    .bind(accountId, collection, id).first<ItemRow>();

syncRoutes.get("/usage", async (c) => {
  const row = await c.env.DB.prepare("SELECT bytes_used FROM accounts WHERE id = ?").bind(c.var.auth.accountId).first<{ bytes_used: number }>();
  return c.json({ bytesUsed: row?.bytes_used ?? 0, quotaBytes: quotaBytes(c.env), keyVersion: await keyVersion(c.env, c.var.auth.accountId) });
});

/** Everything changed after a cursor (a sequence number), oldest first, a page at a time. */
syncRoutes.get("/:collection/changes", async (c) => {
  const collection = check(collectionSchema, c.req.param("collection"));
  const query = check(
    z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(PAGE).default(PAGE) }),
    c.req.query(),
  );
  const { accountId } = c.var.auth;
  const purged = await c.env.DB.prepare("SELECT purge_seq FROM accounts WHERE id = ?").bind(accountId).first<number>("purge_seq");
  if (query.after > 0 && query.after < (purged ?? 0)) {
    throw new HttpError(410, "resync", "This device was away too long to catch up on deletions. Sync again from the start.");
  }
  const { results } = await c.env.DB.prepare(
    "SELECT id, version, key_version, seq, size, deleted, data, blob_key, updated_at FROM items WHERE account_id = ? AND collection = ? AND seq > ? ORDER BY seq LIMIT ?",
  ).bind(accountId, collection, query.after, query.limit + 1).all<ItemRow>();
  const page = results.slice(0, query.limit);
  return c.json({ items: page.map(itemOut), next: page.at(-1)?.seq ?? query.after, more: results.length > query.limit });
});

/** The ciphertext of a large item, as raw bytes. */
syncRoutes.get("/:collection/items/:id/blob", async (c) => {
  const collection = check(collectionSchema, c.req.param("collection"));
  const id = check(itemIdSchema, c.req.param("id"));
  const row = await readItem(c.env, c.var.auth.accountId, collection, id);
  const object = row?.blob_key ? await c.env.BLOBS.get(row.blob_key) : null;
  if (!row || !object) throw new HttpError(404, "no_item", "That item is gone or has changed. Fetch changes again.");
  return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Perch-Item-Version": String(row.version) } });
});
