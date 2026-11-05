import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "./env";
import { normalizeCode, pairingCode, randomToken, safeEqual, sha256Hex } from "./crypto";
import { check, clientIp, deviceSchema, HttpError, idSchema, readJson } from "./http";
import { limit, RULES } from "./ratelimit";
import { requireBrowser, sessionStatement } from "./auth/session";
import { listDevices } from "./devices";

/**
 * Pairing a new device (a Mac, or `perch login` on a cloud computer such as Grok Bot's) with an
 * account, without email. The new device shows an 8-character code; a signed-in device enters it
 * (or scans it as a QR code) and approves. The code is the first 40 bits of SHA-256 of the new
 * device's public key, so the approving device can check the key the server hands it.
 */
export const pairingRoutes = new Hono<HonoEnv>();

const LIFETIME = 10 * 60 * 1000;
const pairingId = z.string().regex(/^pair_[A-Za-z0-9_-]{22}$/, "is not a pairing id");

type PairingRow = {
  id: string; code: string; public_key: string; name: string; kind: string; poll_hash: string;
  status: "pending" | "approved" | "done" | "denied"; account_id: string | null; device_id: string | null;
  approver_device_id: string | null; expires_at: number;
};

pairingRoutes.post("/start", limit(RULES.pairStartIp, (c) => clientIp(c)), async (c) => {
  const device = await readJson(c, deviceSchema);
  const now = c.var.deps.now();
  const id = randomToken("pair", 16);
  const pollSecret = randomToken("pps");
  const code = await pairingCode(device.publicKey);
  // A device that starts again with the same key replaces its own earlier request.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM pairings WHERE code = ? AND status = 'pending'").bind(code),
    c.env.DB.prepare(
      `INSERT INTO pairings (id, code, public_key, name, kind, poll_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(id, code, device.publicKey, device.name, device.kind, await sha256Hex(pollSecret), now, now + LIFETIME),
  ]);
  return c.json({ pairingId: id, code, pollSecret, expiresAt: now + LIFETIME });
});

pairingRoutes.get("/lookup", requireBrowser, limit(RULES.pairLookup, (c) => c.var.auth.accountId), async (c) => {
  const code = normalizeCode(check(z.string().min(8).max(20), c.req.query("code")));
  const row = await c.env.DB.prepare("SELECT * FROM pairings WHERE code = ? AND status = 'pending' AND expires_at > ?")
    .bind(code, c.var.deps.now()).first<PairingRow>();
  if (!row) throw new HttpError(404, "no_pairing", "No device is waiting with that code. Check the code, or start again on the other device.");
  return c.json({ pairingId: row.id, code: row.code, publicKey: row.public_key, name: row.name, kind: row.kind, expiresAt: row.expires_at });
});

pairingRoutes.post("/:id/approve", requireBrowser, async (c) => {
  const id = check(pairingId, c.req.param("id"));
  await readJson(c, z.object({}).strict());
  const { accountId, deviceId } = c.var.auth;
  const now = c.var.deps.now();
  const claimed = await c.env.DB.prepare(
    "UPDATE pairings SET status = 'approved', account_id = ?, approver_device_id = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
  ).bind(accountId, deviceId, id, now).run();
  if (claimed.meta.changes !== 1) throw gone();
  const row = (await c.env.DB.prepare("SELECT * FROM pairings WHERE id = ?").bind(id).first<PairingRow>())!;
  const newDevice = randomToken("dev", 16);
  const device = check(deviceSchema, { name: row.name, kind: row.kind, publicKey: row.public_key });
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO devices (id, account_id, name, kind, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(newDevice, accountId, device.name, device.kind, device.publicKey, now, now),
    c.env.DB.prepare("UPDATE pairings SET device_id = ? WHERE id = ?").bind(newDevice, id),
  ]);
  // The approving device then grants the sync key with PUT /v1/keys/devices/:id, wrapped to this id.
  return c.json({ deviceId: newDevice });
});

pairingRoutes.post("/:id/deny", requireBrowser, async (c) => {
  const id = check(pairingId, c.req.param("id"));
  const result = await c.env.DB.prepare("UPDATE pairings SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(id).run();
  if (result.meta.changes !== 1) throw gone();
  return c.json({ ok: true });
});

/** The new device waits here. On approval it gets its session once, plus the account's devices and their keys. */
pairingRoutes.post("/poll", limit(RULES.pollIp, (c) => clientIp(c)), async (c) => {
  const body = await readJson(c, z.object({ pairingId, pollSecret: z.string().regex(/^pps_[A-Za-z0-9_-]{43}$/) }).strict());
  const now = c.var.deps.now();
  const row = await c.env.DB.prepare("SELECT * FROM pairings WHERE id = ?").bind(body.pairingId).first<PairingRow>();
  if (!row || !safeEqual(await sha256Hex(body.pollSecret), row.poll_hash)) throw new HttpError(404, "no_pairing", "No such pairing request.");
  if (row.status === "pending" && row.expires_at > now) return c.json({ status: "pending" });
  if (row.status !== "approved" || !row.account_id || !row.device_id) throw gone();
  const claimed = await c.env.DB.prepare("UPDATE pairings SET status = 'done' WHERE id = ? AND status = 'approved'").bind(row.id).run();
  if (claimed.meta.changes !== 1) throw gone();
  const session = await sessionForPaired(c.env, row.account_id, row.device_id, now);
  const peers = (await listDevices(c.env, row.account_id)).filter((d) => d.id !== row.device_id);
  return c.json({ status: "approved", ...session, approverDeviceId: row.approver_device_id, peers });
});

async function sessionForPaired(env: AppEnv, accountId: string, deviceId: string, now: number) {
  const { sessionToken, statement } = await sessionStatement(env, accountId, deviceId, now);
  await statement.run();
  return { sessionToken, accountId, deviceId };
}

const gone = () => new HttpError(410, "expired", "This pairing request has expired, was used, or was declined. Start again on the new device.");
