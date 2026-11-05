import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "./env";
import { quotaBytes } from "./env";
import { HttpError, readJson } from "./http";
import { requireAuth, requireBrowser } from "./auth/session";

/** The signed-in account: what it holds, and deleting all of it. */
export const accountRoutes = new Hono<HonoEnv>();
accountRoutes.use(requireAuth);

type AccountRow = { id: string; email: string; created_at: number; bytes_used: number; key_version: number };

accountRoutes.get("/", async (c) => {
  const { accountId, deviceId } = c.var.auth;
  const row = await c.env.DB.prepare("SELECT id, email, created_at, bytes_used, key_version FROM accounts WHERE id = ?").bind(accountId).first<AccountRow>();
  if (!row) throw new HttpError(401, "signed_out", "Sign in to Perch again.");
  return c.json({
    id: row.id, email: row.email, createdAt: row.created_at, bytesUsed: row.bytes_used,
    quotaBytes: quotaBytes(c.env), keyVersion: row.key_version, deviceId,
  });
});

/** Deletes the account, every device, session, key copy and synced item, and closes relay sockets. */
accountRoutes.delete("/", requireBrowser, async (c) => {
  await readJson(c, z.object({ confirm: z.literal("delete my account") }).strict());
  const { accountId } = c.var.auth;
  await deleteAccount(c.env, accountId);
  return c.json({ ok: true });
});

export async function deleteAccount(env: AppEnv, accountId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.BLOBS.list({ prefix: `items/${accountId}/`, cursor });
    if (listed.objects.length) await env.BLOBS.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  const tables = ["items", "wrapped_keys", "passkeys", "sessions", "devices", "challenges"];
  await env.DB.batch([
    ...tables.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE account_id = ?`).bind(accountId)),
    env.DB.prepare("DELETE FROM pairings WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
  ]);
  await env.RELAY.get(env.RELAY.idFromName(accountId)).disconnectAll();
}
