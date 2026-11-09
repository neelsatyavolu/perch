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
  if (id !== c.var.auth.deviceId) browserOnly(c.var.auth.kind);
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
  if (id !== c.var.auth.deviceId) browserOnly(c.var.auth.kind);
  if (!(await revokeDevice(c.env, accountId, id, c.var.deps.now()))) throw noDevice();
  return c.json({ ok: true });
});

/** Revokes a live device of an account (also used by the company admin routes). False if there is none. */
export async function revokeDevice(env: AppEnv, accountId: string, id: string, now: number): Promise<boolean> {
  const [revoked] = await env.DB.batch([
    env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").bind(now, id, accountId),
    env.DB.prepare("DELETE FROM sessions WHERE device_id = ? AND account_id = ?").bind(id, accountId),
    env.DB.prepare("DELETE FROM wrapped_keys WHERE slot = ? AND account_id = ?").bind(id, accountId),
  ]);
  if (revoked?.meta.changes !== 1) return false;
  await env.RELAY.get(env.RELAY.idFromName(accountId)).disconnect(id);
  return true;
}

function browserOnly(kind: string): void {
  if (kind !== "browser") throw new HttpError(403, "browser_only", "Only a Perch browser signed in to this account can change other devices.");
}

const noDevice = () => new HttpError(404, "no_device", "That device is not on this account.");
