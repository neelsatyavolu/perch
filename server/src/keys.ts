import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "./env";
import { randomToken } from "./crypto";
import { base64url, check, HttpError, idSchema, readJson } from "./http";
import { requireBrowser } from "./auth/session";

/**
 * Wrapped copies of the account's sync key. The server never sees the key: each copy is encrypted
 * by a client to one device's public key, or to the recovery key. Versions only go up; a copy for
 * an older version is refused, so a revoked device cannot be handed the new key by mistake.
 */
export const keyRoutes = new Hono<HonoEnv>();
keyRoutes.use(requireBrowser);

const blobSchema = base64url(4096);
const versionSchema = z.number().int().min(1).max(1_000_000);
export const RECOVERY = "recovery";

type WrapRow = { slot: string; version: number; blob: string };

export const keyVersion = async (env: AppEnv, accountId: string): Promise<number> =>
  (await env.DB.prepare("SELECT key_version FROM accounts WHERE id = ?").bind(accountId).first<number>("key_version")) ?? 0;

keyRoutes.get("/", async (c) => {
  const { accountId, deviceId } = c.var.auth;
  const version = await keyVersion(c.env, accountId);
  const { results } = await c.env.DB.prepare("SELECT slot, version, blob FROM wrapped_keys WHERE account_id = ? AND slot IN (?, ?)")
    .bind(accountId, deviceId, RECOVERY).all<WrapRow>();
  const pick = (slot: string) => {
    const row = results.find((r) => r.slot === slot);
    return row ? { version: row.version, blob: row.blob } : null;
  };
  return c.json({ keyVersion: version, device: pick(deviceId), recovery: pick(RECOVERY) });
});

/** Statement that stores a wrapped key for a live device of this account, only at the current version. */
export function grantStatement(env: AppEnv, accountId: string, slot: string, version: number, blob: string, now: number): D1PreparedStatement {
  const target = slot === RECOVERY
    ? "1"
    : "EXISTS (SELECT 1 FROM devices WHERE id = ?2 AND account_id = ?1 AND revoked_at IS NULL)";
  return env.DB.prepare(
    `INSERT INTO wrapped_keys (account_id, slot, version, blob, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT key_version FROM accounts WHERE id = ?1) = ?3 AND ${target}
     ON CONFLICT(account_id, slot) DO UPDATE SET version = excluded.version, blob = excluded.blob, updated_at = excluded.updated_at`,
  ).bind(accountId, slot, version, blob, now);
}

const grantBody = z.object({ version: versionSchema, blob: blobSchema }).strict();

keyRoutes.put("/devices/:id", async (c) => {
  const slot = check(idSchema, c.req.param("id"));
  const body = await readJson(c, grantBody);
  const result = await grantStatement(c.env, c.var.auth.accountId, slot, body.version, body.blob, c.var.deps.now()).run();
  if (result.meta.changes !== 1) throw staleOrMissing();
  return c.json({ ok: true });
});

keyRoutes.put("/recovery", async (c) => {
  const body = await readJson(c, grantBody);
  const result = await grantStatement(c.env, c.var.auth.accountId, RECOVERY, body.version, body.blob, c.var.deps.now()).run();
  if (result.meta.changes !== 1) throw staleOrMissing();
  return c.json({ ok: true });
});

/**
 * Creates the first sync key (version 1) or replaces it. The caller sends copies wrapped for the
 * devices that should keep access, including itself; every other copy is deleted.
 */
keyRoutes.post("/rotate", async (c) => {
  const body = await readJson(
    c,
    z.object({ version: versionSchema, devices: z.record(idSchema, blobSchema), recovery: blobSchema.optional() }).strict(),
  );
  const { accountId, deviceId } = c.var.auth;
  if (!body.devices[deviceId]) throw new HttpError(400, "missing_self", "Include a copy of the key for this device.");
  if (Object.keys(body.devices).length > 100) throw new HttpError(400, "too_many", "Too many devices in one rotation.");
  const now = c.var.deps.now();
  const nonce = randomToken("rot", 16);
  const own = "(SELECT key_rotation FROM accounts WHERE id = ?1) = ?2";
  const statements = [
    c.env.DB.prepare("UPDATE accounts SET key_version = ?2, key_rotation = ?3 WHERE id = ?1 AND key_version = ?2 - 1").bind(accountId, body.version, nonce),
    c.env.DB.prepare(`DELETE FROM wrapped_keys WHERE account_id = ?1 AND ${own}`).bind(accountId, nonce),
    ...Object.entries(body.devices).map(([slot, blob]) =>
      c.env.DB.prepare(
        `INSERT INTO wrapped_keys (account_id, slot, version, blob, updated_at) SELECT ?1, ?3, ?4, ?5, ?6
         WHERE ${own} AND EXISTS (SELECT 1 FROM devices WHERE id = ?3 AND account_id = ?1 AND revoked_at IS NULL)`,
      ).bind(accountId, nonce, slot, body.version, blob, now),
    ),
  ];
  if (body.recovery) {
    statements.push(c.env.DB.prepare(`INSERT INTO wrapped_keys (account_id, slot, version, blob, updated_at) SELECT ?1, ?3, ?4, ?5, ?6 WHERE ${own}`)
      .bind(accountId, nonce, RECOVERY, body.version, body.recovery, now));
  }
  const [rotated, , ...granted] = await c.env.DB.batch(statements);
  if (rotated?.meta.changes !== 1) {
    throw new HttpError(409, "key_version", `The sync key is already at a different version. Fetch keys and try again.`);
  }
  const skipped = Object.keys(body.devices).filter((_, i) => granted[i]?.meta.changes !== 1);
  return c.json({ ok: true, keyVersion: body.version, skipped });
});

const staleOrMissing = () =>
  new HttpError(409, "key_version", "That key version is not current, or the device is not on this account. Fetch keys and try again.");
