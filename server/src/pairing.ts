import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "./env";
import { normalizeCode, randomToken, safeEqual, sha256Hex } from "./crypto";
import { base64url, check, clientIp, deviceSchema, HttpError, readJson } from "./http";
import { limit, RULES } from "./ratelimit";
import { requireBrowser, sessionStatement } from "./auth/session";
import { listDevices } from "./devices";

/**
 * Pairing a new device (a Mac, or `perch login` on a cloud computer such as Grok Bot's) with an
 * account, without email. The new device shows a 16-character code (or a QR code holding it). The
 * first half is a commitment to the device's public key and to the second half, a secret the new
 * device never sends here; the server only ever sees the first half, which it uses to find the
 * request. The approving device checks the key it is handed against the whole code, then leaves a
 * grant sealed to that key with the secret, which this server cannot open or forge.
 */
export const pairingRoutes = new Hono<HonoEnv>();

const LIFETIME = 10 * 60 * 1000;
const pairingId = z.string().regex(/^pair_[A-Za-z0-9_-]{22}$/, "is not a pairing id");
const lookupCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, "is not a pairing code");
export const MAX_GRANT = 16 * 1024;

type PairingRow = {
  id: string; code: string; public_key: string; name: string; kind: string; poll_hash: string;
  status: "pending" | "approved" | "done" | "denied"; account_id: string | null; device_id: string | null;
  approver_device_id: string | null; grant_blob: string | null; expires_at: number;
};

pairingRoutes.post("/start", limit(RULES.pairStartIp, (c) => clientIp(c)), async (c) => {
  const body = await readJson(c, deviceSchema.extend({ code: lookupCode }).strict());
  const now = c.var.deps.now();
  const id = randomToken("pair", 16);
  const pollSecret = randomToken("pps");
  // Finished or expired requests never block a code; a live one is never replaced, so nobody can
  // take over a request someone else is about to approve.
  const [, inserted] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM pairings WHERE code = ? AND (status IN ('denied', 'done') OR expires_at <= ?)").bind(body.code, now),
    c.env.DB.prepare(
      `INSERT INTO pairings (id, code, public_key, name, kind, poll_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(code) DO NOTHING`,
    ).bind(id, body.code, body.publicKey, body.name, body.kind, await sha256Hex(pollSecret), now, now + LIFETIME),
  ]);
  if (inserted?.meta.changes !== 1) throw new HttpError(409, "code_in_use", "That pairing code is already in use. Start pairing again for a new code.");
  return c.json({ pairingId: id, code: body.code, pollSecret, expiresAt: now + LIFETIME });
});

pairingRoutes.get("/lookup", requireBrowser, limit(RULES.pairLookup, (c) => c.var.auth.accountId), async (c) => {
  const code = normalizeCode(check(z.string().min(8).max(20), c.req.query("code")));
  const row = await c.env.DB.prepare("SELECT * FROM pairings WHERE code = ? AND status = 'pending' AND expires_at > ?")
    .bind(code, c.var.deps.now()).first<PairingRow>();
  if (!row) throw new HttpError(404, "no_pairing", "No device is waiting with that code. Check the code, or start again on the other device.");
  return c.json({ pairingId: row.id, code: row.code, publicKey: row.public_key, name: row.name, kind: row.kind, expiresAt: row.expires_at });
});

/** Adds the device and claims the request in one transaction, so a poll never sees half of it. */
pairingRoutes.post("/:id/approve", requireBrowser, async (c) => {
  const id = check(pairingId, c.req.param("id"));
  const { grant } = await readJson(c, z.object({ grant: base64url(MAX_GRANT) }).strict(), MAX_GRANT + 1024);
  const { accountId, deviceId } = c.var.auth;
  const now = c.var.deps.now();
  const newDevice = randomToken("dev", 16);
  const open = "id = ?1 AND status = 'pending' AND expires_at > ?2";
  const [added] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO devices (id, account_id, name, kind, public_key, created_at, last_seen_at)
       SELECT ?3, ?4, name, kind, public_key, ?2, ?2 FROM pairings WHERE ${open}`,
    ).bind(id, now, newDevice, accountId),
    c.env.DB.prepare(
      `UPDATE pairings SET status = 'approved', account_id = ?4, approver_device_id = ?5, device_id = ?3, grant_blob = ?6 WHERE ${open}`,
    ).bind(id, now, newDevice, accountId, deviceId, grant),
  ]);
  if (added?.meta.changes !== 1) throw gone();
  return c.json({ deviceId: newDevice });
});

pairingRoutes.post("/:id/deny", requireBrowser, async (c) => {
  const id = check(pairingId, c.req.param("id"));
  const result = await c.env.DB.prepare("UPDATE pairings SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(id).run();
  if (result.meta.changes !== 1) throw gone();
  return c.json({ ok: true });
});

/** The new device waits here. On approval it gets its session and the sealed grant, once. */
pairingRoutes.post("/poll", limit(RULES.pollIp, (c) => clientIp(c)), async (c) => {
  const body = await readJson(c, z.object({ pairingId, pollSecret: z.string().regex(/^pps_[A-Za-z0-9_-]{43}$/) }).strict());
  const now = c.var.deps.now();
  const row = await c.env.DB.prepare("SELECT * FROM pairings WHERE id = ?").bind(body.pairingId).first<PairingRow>();
  if (!row || !safeEqual(await sha256Hex(body.pollSecret), row.poll_hash)) throw new HttpError(404, "no_pairing", "No such pairing request.");
  if (row.status === "pending" && row.expires_at > now) return c.json({ status: "pending" });
  if (row.status !== "approved" || !row.account_id || !row.device_id || !row.grant_blob) throw gone();
  const claimed = await c.env.DB.prepare("UPDATE pairings SET status = 'done', grant_blob = NULL WHERE id = ? AND status = 'approved'").bind(row.id).run();
  if (claimed.meta.changes !== 1) throw gone();
  const session = await sessionForPaired(c.env, row.account_id, row.device_id, now);
  const peers = (await listDevices(c.env, row.account_id)).filter((d) => d.id !== row.device_id);
  return c.json({ status: "approved", ...session, approverDeviceId: row.approver_device_id, grant: row.grant_blob, peers });
});

async function sessionForPaired(env: AppEnv, accountId: string, deviceId: string, now: number) {
  const { sessionToken, statement } = await sessionStatement(env, accountId, deviceId, now);
  await statement.run();
  return { sessionToken, accountId, deviceId };
}

const gone = () => new HttpError(410, "expired", "This pairing request has expired, was used, or was declined. Start again on the new device.");
