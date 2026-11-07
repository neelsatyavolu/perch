import { Hono, type MiddlewareHandler } from "hono";
import { authMode, type HonoEnv } from "./env";
import { check, HttpError, idSchema } from "./http";
import { consume, RULES } from "./ratelimit";
import { requireAuth } from "./auth/session";
import { revokeDevice } from "./devices";

/**
 * Company admin (AUTH_MODE=company): list every device on the server and revoke any of them.
 * Admins see device names, kinds and dates and the account's email, never keys or synced data,
 * which the server cannot read anyway. Only a Perch browser whose session came from company
 * sign-in with OIDC_ADMIN_GROUP in the verified ID token, in the last 12 hours, may use these.
 */
export const adminRoutes = new Hono<HonoEnv>();

export const ADMIN_SESSION_MAX_AGE = 12 * 60 * 60 * 1000;

const requireAdmin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (authMode(c.env) !== "company") throw new HttpError(404, "not_found", "There is nothing at this address.");
  await requireAuth(c, async () => {
    const { admin, kind, sessionCreatedAt, accountId } = c.var.auth;
    if (!admin || kind !== "browser") throw new HttpError(403, "admin_only", "Only a company admin signed in to Perch can do that.");
    if (c.var.deps.now() - sessionCreatedAt > ADMIN_SESSION_MAX_AGE) {
      throw new HttpError(403, "admin_reauth", "Sign in to Perch again through your company to use admin tools. Admin access lasts 12 hours.");
    }
    await consume(c.env, RULES.admin, accountId);
    await next();
  });
};
adminRoutes.use(requireAdmin);

type AdminDeviceRow = { id: string; account_id: string; email: string; name: string; kind: string; created_at: number; last_seen_at: number; revoked_at: number | null };

adminRoutes.get("/devices", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.account_id, a.email, d.name, d.kind, d.created_at, d.last_seen_at, d.revoked_at
     FROM devices d JOIN accounts a ON a.id = d.account_id ORDER BY d.created_at`,
  ).all<AdminDeviceRow>();
  const devices = results.map((d) => ({
    id: d.id, accountEmail: d.email, name: d.name, kind: d.kind, createdAt: d.created_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at,
  }));
  return c.json({ devices });
});

/** Revokes any device: its sessions and key copy are deleted and its relay socket closed. */
adminRoutes.delete("/devices/:id", async (c) => {
  const id = check(idSchema, c.req.param("id"));
  const owner = await c.env.DB.prepare("SELECT account_id FROM devices WHERE id = ? AND revoked_at IS NULL").bind(id).first<{ account_id: string }>();
  if (!owner || !(await revokeDevice(c.env, owner.account_id, id, c.var.deps.now()))) {
    throw new HttpError(404, "no_device", "There is no device with that id on this server, or it was already removed.");
  }
  return c.json({ ok: true });
});
