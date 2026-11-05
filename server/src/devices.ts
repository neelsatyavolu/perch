import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "./env";
import { check, deviceNameSchema, HttpError, idSchema, readJson } from "./http";
import { requireAuth } from "./auth/session";

/** The account's devices: list, rename, revoke (spec 9.3: every device listed with last use). */
export const deviceRoutes = new Hono<HonoEnv>();
deviceRoutes.use(requireAuth);

type DeviceRow = { id: string; name: string; kind: string; public_key: string; created_at: number; last_seen_at: number };

export async function listDevices(env: AppEnv, accountId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, kind, public_key, created_at, last_seen_at FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at",
  ).bind(accountId).all<DeviceRow>();
  return results.map((d) => ({ id: d.id, name: d.name, kind: d.kind, publicKey: d.public_key, createdAt: d.created_at, lastSeenAt: d.last_seen_at }));
}

deviceRoutes.get("/", async (c) => {
  const { accountId, deviceId } = c.var.auth;
  const devices = await listDevices(c.env, accountId);
  return c.json({ devices: devices.map((d) => ({ ...d, current: d.id === deviceId })) });
});

deviceRoutes.patch("/:id", async (c) => {
  const id = check(idSchema, c.req.param("id"));
  const { name } = await readJson(c, z.object({ name: deviceNameSchema }).strict());
  const result = await c.env.DB.prepare("UPDATE devices SET name = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
    .bind(name, id, c.var.auth.accountId).run();
  if (result.meta.changes !== 1) throw noDevice();
  return c.json({ ok: true });
});

/**
 * Revokes a device: its sessions and wrapped sync key are deleted and its relay socket closed.
 * Revoking the current device is how a device signs out. Other devices should rotate the sync key
 * afterwards (POST /v1/keys/rotate), which Perch's client does.
 */
deviceRoutes.delete("/:id", async (c) => {
  const id = check(idSchema, c.req.param("id"));
  const { accountId } = c.var.auth;
  const [revoked] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").bind(c.var.deps.now(), id, accountId),
    c.env.DB.prepare("DELETE FROM sessions WHERE device_id = ? AND account_id = ?").bind(id, accountId),
    c.env.DB.prepare("DELETE FROM wrapped_keys WHERE slot = ? AND account_id = ?").bind(id, accountId),
  ]);
  if (revoked?.meta.changes !== 1) throw noDevice();
  await c.env.RELAY.get(c.env.RELAY.idFromName(accountId)).disconnect(id);
  return c.json({ ok: true });
});

const noDevice = () => new HttpError(404, "no_device", "That device is not on this account.");
