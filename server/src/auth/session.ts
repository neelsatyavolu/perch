import type { MiddlewareHandler } from "hono";
import type { AppEnv, Auth, HonoEnv } from "../env";
import { randomToken, sha256Hex } from "../crypto";
import { HttpError, type DeviceInput } from "../http";
import { consume, RULES } from "../ratelimit";

const DAY = 24 * 60 * 60 * 1000;
export const SESSION_LIFETIME = 90 * DAY;
/** A session used within this long of expiring is extended to a full lifetime. */
const EXTEND_WHEN_LEFT = 60 * DAY;
const SEEN_EVERY = 60 * 60 * 1000;

export type NewSession = { sessionToken: string; accountId: string; deviceId: string };

/** Statements that add a device to an account. */
export function insertDevice(env: AppEnv, accountId: string, deviceId: string, device: DeviceInput, now: number): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO devices (id, account_id, name, kind, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(deviceId, accountId, device.name, device.kind, device.publicKey, now, now);
}

/** Creates a session for an existing device. Only the hash of the token is stored. */
export async function sessionStatement(env: AppEnv, accountId: string, deviceId: string, now: number) {
  const sessionToken = randomToken("pst");
  const statement = env.DB.prepare(
    "INSERT INTO sessions (token_hash, account_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256Hex(sessionToken), accountId, deviceId, now, now + SESSION_LIFETIME);
  return { sessionToken, statement };
}

/** Adds a device and its first session to an account in one transaction. */
export async function createDeviceSession(env: AppEnv, accountId: string, device: DeviceInput, now: number, extra: D1PreparedStatement[] = []): Promise<NewSession> {
  const deviceId = randomToken("dev", 16);
  const { sessionToken, statement } = await sessionStatement(env, accountId, deviceId, now);
  await env.DB.batch([...extra, insertDevice(env, accountId, deviceId, device, now), statement]);
  return { sessionToken, accountId, deviceId };
}

/** Finds the account for an email, creating it on first sign-in. */
export async function accountForEmail(env: AppEnv, email: string, now: number): Promise<{ id: string; created: boolean }> {
  const found = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?").bind(email).first<{ id: string }>();
  if (found) return { id: found.id, created: false };
  const id = randomToken("acc", 16);
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING").bind(id, email, now).run();
  const row = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?").bind(email).first<{ id: string }>();
  if (!row) throw new HttpError(500, "account_failed", "The account could not be created. Try again.");
  return { id: row.id, created: row.id === id };
}

type SessionRow = { account_id: string; device_id: string; expires_at: number; last_seen_at: number; kind: string };

/** Resolves a bearer token to its account and device, or null if it is unknown, expired or revoked. */
export async function authenticate(env: AppEnv, header: string | undefined, now: number): Promise<Auth | null> {
  const match = /^Bearer (pst_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
  if (!match?.[1]) return null;
  const hash = await sha256Hex(match[1]);
  const row = await env.DB.prepare(
    `SELECT s.account_id, s.device_id, s.expires_at, d.last_seen_at, d.kind FROM sessions s
     JOIN devices d ON d.id = s.device_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND d.revoked_at IS NULL`,
  ).bind(hash, now).first<SessionRow>();
  if (!row) return null;
  const updates: D1PreparedStatement[] = [];
  if (row.expires_at - now < EXTEND_WHEN_LEFT) {
    updates.push(env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(now + SESSION_LIFETIME, hash));
  }
  if (now - row.last_seen_at > SEEN_EVERY) {
    updates.push(env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now, row.device_id));
  }
  if (updates.length) await env.DB.batch(updates);
  return { accountId: row.account_id, deviceId: row.device_id, kind: row.kind };
}

/** Requires a valid session, then applies the per-account rate limit. */
export const requireAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const auth = await authenticate(c.env, c.req.header("authorization"), c.var.deps.now());
  if (!auth) throw new HttpError(401, "signed_out", "Sign in to Perch again.", { "WWW-Authenticate": "Bearer" });
  await consume(c.env, RULES.account, auth.accountId);
  c.set("auth", auth);
  await next();
};

/**
 * Only Perch browsers may change the account: sync, keys, pairing, passkeys, other devices.
 * A paired remote CLI (kind cli or assistant, such as Grok Bot's computer) can use the relay,
 * read the account and device list, and remove itself, and nothing else.
 */
export const requireBrowser: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const onlyBrowsers = async () => {
    if (c.var.auth.kind !== "browser") throw new HttpError(403, "browser_only", "Only a Perch browser signed in to this account can do that.");
    await next();
  };
  // Already authenticated by a router-level requireAuth: do not look the session up twice.
  if (c.get("auth")) return onlyBrowsers();
  await requireAuth(c, onlyBrowsers);
};
