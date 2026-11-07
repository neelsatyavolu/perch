import { Hono, type Context } from "hono";
import { z } from "zod";
import { authMode, type AppEnv, type Deps, type HonoEnv } from "../env";
import { randomBytes, randomToken, safeEqual, sha256, sha256Hex, toBase64Url } from "../crypto";
import { check, clientIp, deviceSchema, HttpError, readJson } from "../http";
import { logEvent } from "../log";
import { limit, RULES } from "../ratelimit";
import { type Claims, JwtError } from "./jwt";
import { goPage, resultPage } from "./oidc-pages";
import { discover, exchangeCode, oidcConfig, ProviderError, scopesFor } from "./oidc-provider";
import { createDeviceSession } from "./session";

/**
 * Company sign-in (AUTH_MODE=company) through the company's OpenID Connect provider. The device
 * starts a request and opens the go link in Perch. The go page asks for the number the device
 * shows (a wrong number cancels), then sends the browser to the provider with state, nonce and a
 * PKCE challenge, and leaves a short-lived cookie that ties the callback to that browser. So a
 * forwarded go link, or a forwarded provider URL, cannot sign the sender's device in. The callback
 * verifies the ID token and links its (iss, sub) to an account; the session goes only to the
 * device holding the poll secret, once.
 */
export const oidcRoutes = new Hono<HonoEnv>();

const LIFETIME = 15 * 60 * 1000;
const COOKIE = "__Host-perch-oidc";
const requestIdSchema = z.string().regex(/^oreq_[A-Za-z0-9_-]{22}$/, "is not a sign-in request");
const requestRef = z.object({ requestId: requestIdSchema, pollSecret: z.string().regex(/^ops_[A-Za-z0-9_-]{43}$/) }).strict();
const stateSchema = z.string().regex(/^ost_[A-Za-z0-9_-]{43}$/);
const WAITING = "status IN ('pending', 'authorizing')";
const CLEARED = "state_hash = NULL, binding_hash = NULL, nonce = NULL, verifier = NULL";

type RequestRow = {
  id: string; poll_hash: string; binding_hash: string | null; nonce: string | null; verifier: string | null;
  match_number: number; device_name: string; device_kind: string; device_public_key: string;
  status: "pending" | "authorizing" | "verifying" | "approved" | "done" | "failed";
  account_id: string | null; admin: number; expires_at: number;
};

const MESSAGES = {
  signedIn: "Perch is signed in. You can close this tab.",
  incomplete: "This sign-in link is incomplete. Start again in Perch.",
  expired: "This sign-in has expired, was used, or was cancelled. Start again in Perch.",
  otherBrowser: "This sign-in was started in a different browser, so it was cancelled. Start again in Perch.",
  refused: "Your company's sign-in service did not sign you in. Start again in Perch.",
  unchecked: "Perch could not check the answer from your company's sign-in service, so this sign-in was cancelled. Start again in Perch.",
  unreachable: "Perch could not reach your company's sign-in service. Start again in Perch in a minute.",
} as const;

/** A callback that cancels the request: a log-safe reason and the message the page shows. */
class Cancel extends Error {
  constructor(readonly reason: string, readonly page: string) {
    super(reason);
  }
}

const ipKey = (c: Context<HonoEnv>) => clientIp(c);
const expired = () => new HttpError(410, "expired", "This sign-in request has expired or was cancelled. Start again in Perch.");
const unreachable = (error: unknown) => {
  if (error instanceof ProviderError) {
    logEvent("oidc_failed", { error: error.reason });
    return new HttpError(502, "provider_unavailable", "Perch could not reach your company's sign-in service. Try again in a minute.");
  }
  return error;
};

oidcRoutes.use(async (c, next) => {
  if (authMode(c.env) !== "company") throw new HttpError(404, "not_found", "There is nothing at this address.");
  await next();
});

oidcRoutes.post("/start", limit(RULES.oidcStartIp, ipKey), async (c) => {
  oidcConfig(c.env);
  const body = await readJson(c, z.object({ device: deviceSchema }).strict());
  const now = c.var.deps.now();
  const requestId = randomToken("oreq", 16);
  const pollSecret = randomToken("ops");
  const matchNumber = 10 + (randomBytes(1)[0]! % 90);
  await c.env.DB.prepare(
    `INSERT INTO oidc_requests (id, poll_hash, match_number, device_name, device_kind, device_public_key, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(requestId, await sha256Hex(pollSecret), matchNumber, body.device.name, body.device.kind, body.device.publicKey, now, now + LIFETIME).run();
  const url = `${c.env.API_ORIGIN}/v1/auth/oidc/go?r=${requestId}`;
  return c.json({ requestId, pollSecret, matchNumber, url, expiresAt: now + LIFETIME });
});

oidcRoutes.get("/go", (c) => {
  const nonce = randomToken("n", 16);
  c.header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`);
  return c.html(goPage(nonce));
});

oidcRoutes.post("/go/info", limit(RULES.oidcBrowserIp, ipKey), async (c) => {
  const { requestId } = await readJson(c, z.object({ requestId: requestIdSchema }).strict());
  const row = await waitingRequest(c.env, requestId, c.var.deps.now());
  return c.json({ deviceName: row.device_name });
});

/** The right number: a fresh state, nonce and PKCE verifier, and the provider URL to go to. */
oidcRoutes.post("/go", limit(RULES.oidcBrowserIp, ipKey), async (c) => {
  const body = await readJson(c, z.object({ requestId: requestIdSchema, match: z.number().int().min(10).max(99) }).strict());
  const config = oidcConfig(c.env);
  const now = c.var.deps.now();
  const row = await waitingRequest(c.env, body.requestId, now);
  if (row.match_number !== body.match) {
    await c.env.DB.prepare(`UPDATE oidc_requests SET status = 'failed', ${CLEARED} WHERE id = ? AND ${WAITING}`).bind(row.id).run();
    throw new HttpError(400, "wrong_number", "That number did not match, so this sign-in was cancelled. Start again in Perch.");
  }
  const provider = await discover(c.var.deps, config.issuer).catch((error) => Promise.reject(unreachable(error)));
  const state = randomToken("ost");
  const nonce = randomToken("onc");
  const verifier = toBase64Url(randomBytes(32));
  const binding = randomToken("obd");
  const updated = await c.env.DB.prepare(
    `UPDATE oidc_requests SET status = 'authorizing', state_hash = ?, binding_hash = ?, nonce = ?, verifier = ? WHERE id = ? AND ${WAITING} AND expires_at > ?`,
  ).bind(await sha256Hex(state), await sha256Hex(binding), nonce, verifier, row.id, now).run();
  if (updated.meta.changes !== 1) throw expired();
  const url = new URL(provider.authorization_endpoint);
  const params = {
    response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: scopesFor(provider),
    state, nonce, code_challenge: toBase64Url(await sha256(verifier)), code_challenge_method: "S256",
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  c.header("Set-Cookie", `${COOKIE}=${binding}; Path=/; Max-Age=${LIFETIME / 1000}; Secure; HttpOnly; SameSite=Lax`);
  return c.json({ url: url.toString() });
});

oidcRoutes.get("/callback", limit(RULES.oidcBrowserIp, ipKey), async (c) => {
  const nonce = randomToken("n", 16);
  c.header("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`);
  c.header("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  const show = (message: string, ok = false) => c.html(resultPage(nonce, message, !ok), ok ? 200 : 400);
  const state = stateSchema.safeParse(c.req.query("state"));
  if (!state.success) return show(MESSAGES.incomplete);
  const now = c.var.deps.now();
  // Claiming the request first means a state works once, even when two callbacks race.
  const row = await c.env.DB.prepare(
    "UPDATE oidc_requests SET status = 'verifying' WHERE state_hash = ? AND status = 'authorizing' AND expires_at > ? RETURNING *",
  ).bind(await sha256Hex(state.data), now).first<RequestRow>();
  if (!row) return show(MESSAGES.expired);
  try {
    await approve(c, row, now);
    return show(MESSAGES.signedIn, true);
  } catch (error) {
    await c.env.DB.prepare(`UPDATE oidc_requests SET status = 'failed', ${CLEARED} WHERE id = ?`).bind(row.id).run();
    const reason = error instanceof Cancel || error instanceof JwtError || error instanceof ProviderError ? error.reason : "unexpected";
    logEvent("oidc_failed", { error: reason });
    const page = error instanceof Cancel ? error.page : error instanceof ProviderError ? MESSAGES.unreachable : MESSAGES.unchecked;
    return show(page);
  }
});

oidcRoutes.post("/poll", limit(RULES.pollIp, ipKey), async (c) => {
  const body = await readJson(c, requestRef);
  const now = c.var.deps.now();
  const row = await c.env.DB.prepare("SELECT * FROM oidc_requests WHERE id = ?").bind(body.requestId).first<RequestRow>();
  if (!row || !safeEqual(await sha256Hex(body.pollSecret), row.poll_hash)) throw new HttpError(404, "not_found", "No such sign-in request.");
  if (row.expires_at <= now) throw expired();
  if (row.status === "pending" || row.status === "authorizing" || row.status === "verifying") return c.json({ status: "pending" });
  if (row.status !== "approved" || !row.account_id) throw expired();
  const claimed = await c.env.DB.prepare("UPDATE oidc_requests SET status = 'done' WHERE id = ? AND status = 'approved'").bind(row.id).run();
  if (claimed.meta.changes !== 1) throw expired();
  const device = check(deviceSchema, { name: row.device_name, kind: row.device_kind, publicKey: row.device_public_key });
  const admin = row.admin === 1;
  const session = await createDeviceSession(c.env, row.account_id, device, now, [], admin);
  return c.json({ status: "signed_in", ...session, admin });
});

async function waitingRequest(env: AppEnv, requestId: string, now: number): Promise<RequestRow> {
  const row = await env.DB.prepare(`SELECT * FROM oidc_requests WHERE id = ? AND ${WAITING} AND expires_at > ?`).bind(requestId, now).first<RequestRow>();
  if (!row) throw expired();
  return row;
}

/** Checks the browser, swaps the code, verifies the ID token and marks the request approved. */
async function approve(c: Context<HonoEnv>, row: RequestRow, now: number): Promise<void> {
  const binding = readCookie(c.req.header("cookie"), COOKIE);
  if (!binding || !row.binding_hash || !safeEqual(await sha256Hex(binding), row.binding_hash)) throw new Cancel("other_browser", MESSAGES.otherBrowser);
  if (c.req.query("error") !== undefined) throw new Cancel("provider_refused", MESSAGES.refused);
  const code = c.req.query("code");
  if (!code || code.length > 4096 || !row.nonce || !row.verifier) throw new Cancel("no_code", MESSAGES.incomplete);
  const config = oidcConfig(c.env);
  const deps: Deps = c.var.deps;
  const provider = await discover(deps, config.issuer);
  const claims = await exchangeCode(deps, config, provider, code, row.verifier, row.nonce);
  const accountId = await accountForIdentity(c.env, config.issuer, claims, now);
  const admin = !!config.adminGroup && Array.isArray(claims.groups) && claims.groups.some((group) => group === config.adminGroup);
  const approved = await c.env.DB.prepare(`UPDATE oidc_requests SET status = 'approved', account_id = ?, admin = ?, ${CLEARED} WHERE id = ? AND status = 'verifying'`)
    .bind(accountId, admin ? 1 : 0, row.id).run();
  if (approved.meta.changes !== 1) throw new Cancel("expired", MESSAGES.expired);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** The email shown for an account. Display only: the account key is (issuer, subject). */
function displayNames(claims: Claims): string[] {
  const names = [claims.email, claims.preferred_username]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0 && v.length <= 254);
  return [...new Set(names)];
}

/** Finds the account for (issuer, subject), creating it on first sign-in, and refreshes its email. */
async function accountForIdentity(env: AppEnv, issuer: string, claims: Claims, now: number): Promise<string> {
  const lookup = env.DB.prepare("SELECT account_id FROM identities WHERE issuer = ? AND subject = ?").bind(issuer, claims.sub);
  const names = displayNames(claims);
  const found = await lookup.first<{ account_id: string }>();
  if (found) {
    // A name another account already shows is left alone.
    if (names[0]) await env.DB.prepare("UPDATE OR IGNORE accounts SET email = ? WHERE id = ?").bind(names[0], found.account_id).run();
    return found.account_id;
  }
  const id = randomToken("acc", 16);
  for (const name of [...names, `${claims.sub}@${new URL(issuer).hostname}`, id]) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO accounts (id, email, created_at) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM identities WHERE issuer = ?4 AND subject = ?5)",
      ).bind(id, name, now, issuer, claims.sub),
      env.DB.prepare(
        "INSERT OR IGNORE INTO identities (issuer, subject, account_id) SELECT ?2, ?3, ?1 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?1)",
      ).bind(id, issuer, claims.sub),
      // Lost a race to another first sign-in of the same person: drop the spare account.
      env.DB.prepare("DELETE FROM accounts WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM identities WHERE account_id = ?1)").bind(id),
    ]);
    const linked = await lookup.first<{ account_id: string }>();
    if (linked) return linked.account_id;
  }
  throw new Cancel("account_failed", MESSAGES.unchecked);
}
