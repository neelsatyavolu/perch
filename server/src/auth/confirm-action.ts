import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "../env";
import { normalizeCode, randomCode, randomToken, safeEqual, sha256Hex } from "../crypto";
import { HttpError, readJson } from "../http";
import { consume, RULES } from "../ratelimit";
import { requireBrowser } from "./session";

/**
 * A fresh email confirmation for actions a session alone must not take: deleting the account and
 * adding a passkey. Someone who tricked a person into one sign-in still cannot do these without
 * reading that person's email again. The device asks for a code, the person types it back.
 */
export const confirmRoutes = new Hono<HonoEnv>();

const LIFETIME = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
export const ACTIONS = { delete_account: "delete your Perch account", add_passkey: "add a passkey to your Perch account" } as const;
export type ConfirmAction = keyof typeof ACTIONS;

/** What a request that needs confirming carries. */
export const confirmationSchema = z.object({
  confirmationId: z.string().regex(/^cnf_[A-Za-z0-9_-]{22}$/, "is not a confirmation id"),
  code: z.string().max(20),
});

confirmRoutes.post("/", requireBrowser, async (c) => {
  const { action } = await readJson(c, z.object({ action: z.enum(Object.keys(ACTIONS) as [ConfirmAction, ...ConfirmAction[]]) }).strict());
  const { accountId, deviceId } = c.var.auth;
  await consume(c.env, RULES.confirmStart, accountId);
  const account = await c.env.DB.prepare("SELECT email FROM accounts WHERE id = ?").bind(accountId).first<{ email: string }>();
  if (!account) throw new HttpError(401, "signed_out", "Sign in to Perch again.");
  const now = c.var.deps.now();
  const id = randomToken("cnf", 16);
  const code = randomCode();
  await c.env.DB.prepare("INSERT INTO confirmations (id, account_id, device_id, action, code_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, accountId, deviceId, action, await sha256Hex(code), now + LIFETIME).run();
  const text = [
    `Perch was asked to ${ACTIONS[action]}.`,
    "",
    `To go ahead, type this code in Perch: ${code}`,
    "",
    "The code works for 10 minutes. If this was not you, do not share the code, and remove devices you do not know in Perch Settings.",
  ].join("\n");
  const html = `<p>Perch was asked to ${ACTIONS[action]}.</p>
<p>To go ahead, type this code in Perch: <strong style="font-family:monospace">${code}</strong></p>
<p>The code works for 10 minutes. If this was not you, do not share the code, and remove devices you do not know in Perch Settings.</p>`;
  await c.var.deps.mailer.send({ to: account.email, subject: "Confirm a change to your Perch account", text, html });
  return c.json({ confirmationId: id, expiresAt: now + LIFETIME });
});

/** Uses up a confirmation for this device and action, or throws. Wrong codes count toward a limit. */
export async function requireConfirmation(env: AppEnv, auth: { accountId: string; deviceId: string }, action: ConfirmAction, ref: z.infer<typeof confirmationSchema>, now: number): Promise<void> {
  const row = await env.DB.prepare("SELECT id, code_hash, attempts, expires_at FROM confirmations WHERE id = ? AND account_id = ? AND device_id = ? AND action = ?")
    .bind(ref.confirmationId, auth.accountId, auth.deviceId, action).first<{ id: string; code_hash: string; attempts: number; expires_at: number }>();
  if (!row || row.expires_at <= now || row.attempts >= MAX_ATTEMPTS) {
    throw new HttpError(403, "confirmation_expired", "That confirmation has expired or was used. Ask for a new code.");
  }
  if (!safeEqual(await sha256Hex(normalizeCode(ref.code)), row.code_hash)) {
    await env.DB.prepare("UPDATE confirmations SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    throw new HttpError(403, "wrong_code", "That code is not right. Check the email and try again.");
  }
  const used = await env.DB.prepare("DELETE FROM confirmations WHERE id = ?").bind(row.id).run();
  if (used.meta.changes !== 1) throw new HttpError(403, "confirmation_expired", "That confirmation has expired or was used. Ask for a new code.");
}
