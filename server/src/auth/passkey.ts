import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AppEnv, HonoEnv } from "../env";
import { passkeyOrigins } from "../env";
import { fromBase64Url, randomToken, toBase64Url } from "../crypto";
import { clientIp, deviceSchema, HttpError, readJson } from "../http";
import { limit, RULES } from "../ratelimit";
import { createDeviceSession, requireBrowser } from "./session";

/**
 * Passkeys (WebAuthn). A signed-in device adds one; later any device signs in with it and no
 * email. User verification is required, so a passkey stands in for both factors.
 */
export const passkeyRoutes = new Hono<HonoEnv>();

const CHALLENGE_LIFETIME = 5 * 60 * 1000;
const challengeId = z.string().regex(/^chl_[A-Za-z0-9_-]{22}$/);
// The browser's JSON form of a credential; @simplewebauthn checks every field that matters.
const credentialJson = z.object({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal("public-key"), response: z.record(z.string(), z.unknown()) }).passthrough();
const ipKey = (c: Context<HonoEnv>) => clientIp(c);

type PasskeyRow = { id: string; account_id: string; public_key: string; counter: number; transports: string };

async function saveChallenge(env: AppEnv, kind: "register" | "login", challenge: string, accountId: string | null, now: number) {
  const id = randomToken("chl", 16);
  await env.DB.prepare("INSERT INTO challenges (id, account_id, kind, challenge, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, accountId, kind, challenge, now + CHALLENGE_LIFETIME).run();
  return id;
}

/** Takes a challenge once: it is deleted whether or not the response checks out. */
async function takeChallenge(env: AppEnv, id: string, kind: string, now: number): Promise<{ challenge: string; account_id: string | null }> {
  const row = await env.DB.prepare("DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING challenge, account_id, expires_at")
    .bind(id, kind).first<{ challenge: string; account_id: string | null; expires_at: number }>();
  if (!row || row.expires_at <= now) throw new HttpError(400, "challenge_expired", "The passkey request expired. Try again.");
  return row;
}

const failed = () => new HttpError(400, "passkey_failed", "The passkey could not be checked. Try again, or sign in by email.");

passkeyRoutes.post("/register/options", requireBrowser, async (c) => {
  const { accountId } = c.var.auth;
  const account = await c.env.DB.prepare("SELECT email FROM accounts WHERE id = ?").bind(accountId).first<{ email: string }>();
  const { results } = await c.env.DB.prepare("SELECT id, transports FROM passkeys WHERE account_id = ?").bind(accountId).all<PasskeyRow>();
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME,
    rpID: c.env.RP_ID,
    userName: account?.email ?? "Perch account",
    userID: new Uint8Array(new TextEncoder().encode(accountId)),
    attestationType: "none",
    excludeCredentials: results.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) as string[] })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const id = await saveChallenge(c.env, "register", options.challenge, accountId, c.var.deps.now());
  return c.json({ challengeId: id, options });
});

passkeyRoutes.post("/register/verify", requireBrowser, async (c) => {
  const body = await readJson(c, z.object({ challengeId, response: credentialJson }).strict(), 64 * 1024);
  const now = c.var.deps.now();
  const challenge = await takeChallenge(c.env, body.challengeId, "register", now);
  if (challenge.account_id !== c.var.auth.accountId) throw failed();
  const result = await verifyRegistrationResponse({
    response: body.response as unknown as RegistrationResponseJSON,
    expectedChallenge: challenge.challenge,
    expectedOrigin: passkeyOrigins(c.env),
    expectedRPID: c.env.RP_ID,
    requireUserVerification: true,
  }).catch(() => null);
  if (!result?.verified) throw failed();
  const { credential } = result.registrationInfo;
  await c.env.DB.prepare("INSERT INTO passkeys (id, account_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(credential.id, c.var.auth.accountId, toBase64Url(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), now).run();
  return c.json({ ok: true, passkeyId: credential.id });
});

passkeyRoutes.post("/login/options", limit(RULES.passkeyIp, ipKey), async (c) => {
  const options = await generateAuthenticationOptions({ rpID: c.env.RP_ID, userVerification: "required" });
  const id = await saveChallenge(c.env, "login", options.challenge, null, c.var.deps.now());
  return c.json({ challengeId: id, options });
});

passkeyRoutes.post("/login/verify", limit(RULES.passkeyIp, ipKey), async (c) => {
  const body = await readJson(c, z.object({ challengeId, response: credentialJson, device: deviceSchema }).strict(), 64 * 1024);
  const now = c.var.deps.now();
  const challenge = await takeChallenge(c.env, body.challengeId, "login", now);
  const passkey = await c.env.DB.prepare("SELECT * FROM passkeys WHERE id = ?").bind(body.response.id).first<PasskeyRow>();
  if (!passkey) throw failed();
  const result = await verifyAuthenticationResponse({
    response: body.response as unknown as AuthenticationResponseJSON,
    expectedChallenge: challenge.challenge,
    expectedOrigin: passkeyOrigins(c.env),
    expectedRPID: c.env.RP_ID,
    credential: { id: passkey.id, publicKey: fromBase64Url(passkey.public_key), counter: passkey.counter, transports: JSON.parse(passkey.transports) as string[] },
    requireUserVerification: true,
  }).catch(() => null);
  if (!result?.verified) throw failed();
  const counter = c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(result.authenticationInfo.newCounter, now, passkey.id);
  const session = await createDeviceSession(c.env, passkey.account_id, body.device, now, [counter]);
  return c.json({ status: "signed_in", ...session });
});

passkeyRoutes.get("/", requireBrowser, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, created_at, last_used_at FROM passkeys WHERE account_id = ? ORDER BY created_at")
    .bind(c.var.auth.accountId).all<{ id: string; created_at: number; last_used_at: number | null }>();
  return c.json({ passkeys: results.map((p) => ({ id: p.id, createdAt: p.created_at, lastUsedAt: p.last_used_at })) });
});

passkeyRoutes.delete("/:id", requireBrowser, async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND account_id = ?").bind(c.req.param("id"), c.var.auth.accountId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "no_passkey", "That passkey is not on this account.");
  return c.json({ ok: true });
});
