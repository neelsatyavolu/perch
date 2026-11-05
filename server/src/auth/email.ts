import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "../env";
import { randomBytes, randomCode, randomToken, normalizeCode, safeEqual, sha256Hex } from "../crypto";
import { check, clientIp, deviceSchema, HttpError, readJson } from "../http";
import { consume, limit, RULES } from "../ratelimit";
import { accountForEmail, createDeviceSession } from "./session";
import { confirmPage } from "./confirm-page";

/**
 * Email sign-in. The email holds a link and a code. The link opens a confirm page that asks the
 * person to pick the number shown on the device that asked, so nobody signs a stranger's device in
 * with one careless click. The code is typed into that device directly. Either way the session
 * goes only to the device holding the poll secret.
 */
export const emailRoutes = new Hono<HonoEnv>();

const LIFETIME = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const linkToken = z.string().regex(/^elk_[A-Za-z0-9_-]{43}$/, "is not a sign-in link");
const requestRef = z.object({ requestId: z.string().regex(/^ereq_[A-Za-z0-9_-]{22}$/), pollSecret: z.string().regex(/^eps_[A-Za-z0-9_-]{43}$/) }).strict();

type RequestRow = {
  id: string;
  email: string;
  code_hash: string;
  poll_hash: string;
  match_number: number;
  device_name: string;
  device_kind: string;
  device_public_key: string;
  attempts: number;
  status: "pending" | "approved" | "done" | "failed";
  expires_at: number;
};

const ipKey = (c: Context<HonoEnv>) => clientIp(c);
const expired = () => new HttpError(410, "expired", "This sign-in request has expired or was cancelled. Start again in Perch.");

emailRoutes.post("/start", limit(RULES.emailStartIp, ipKey), async (c) => {
  const body = await readJson(c, z.object({ email: emailSchema, device: deviceSchema }).strict());
  await consume(c.env, RULES.emailStartAddress, body.email);
  const now = c.var.deps.now();
  const requestId = randomToken("ereq", 16);
  const pollSecret = randomToken("eps");
  const token = randomToken("elk");
  const code = randomCode();
  const matchNumber = 10 + (randomBytes(1)[0]! % 90);
  await c.env.DB.prepare(
    `INSERT INTO email_requests (id, email, link_hash, code_hash, poll_hash, match_number, device_name, device_kind,
     device_public_key, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(requestId, body.email, await sha256Hex(token), await sha256Hex(code), await sha256Hex(pollSecret), matchNumber,
    body.device.name, body.device.kind, body.device.publicKey, now, now + LIFETIME).run();
  try {
    await c.var.deps.mailer.send(signInEmail(c.env, body.email, body.device.name, token, code));
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM email_requests WHERE id = ?").bind(requestId).run();
    throw error;
  }
  // The same answer whether or not the address has an account, so this cannot be used to probe.
  return c.json({ requestId, pollSecret, matchNumber, expiresAt: now + LIFETIME });
});

emailRoutes.get("/confirm", (c) => {
  const nonce = randomToken("n", 16);
  c.header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`);
  return c.html(confirmPage(nonce));
});

emailRoutes.post("/confirm/info", limit(RULES.emailVerifyIp, ipKey), async (c) => {
  const { token } = await readJson(c, z.object({ token: linkToken }).strict());
  const row = await pendingByLink(c.env, token, c.var.deps.now());
  return c.json({ deviceName: row.device_name, choices: choicesFor(row.match_number) });
});

emailRoutes.post("/confirm", limit(RULES.emailVerifyIp, ipKey), async (c) => {
  const body = await readJson(c, z.object({ token: linkToken, match: z.number().int().min(10).max(99) }).strict());
  const row = await pendingByLink(c.env, body.token, c.var.deps.now());
  const ok = row.match_number === body.match;
  await c.env.DB.prepare("UPDATE email_requests SET status = ? WHERE id = ? AND status = 'pending'").bind(ok ? "approved" : "failed", row.id).run();
  if (!ok) throw new HttpError(400, "wrong_number", "That number did not match, so this sign-in was cancelled. Start again in Perch.");
  return c.json({ deviceName: row.device_name });
});

emailRoutes.post("/verify", limit(RULES.emailVerifyIp, ipKey), async (c) => {
  const body = await readJson(c, requestRef.extend({ code: z.string().max(20) }).strict());
  const row = await requestFor(c.env, body, c.var.deps.now());
  if (row.status !== "pending" && row.status !== "approved") throw expired();
  if (!safeEqual(await sha256Hex(normalizeCode(body.code)), row.code_hash)) {
    const failed = row.attempts + 1 >= MAX_CODE_ATTEMPTS;
    await c.env.DB.prepare("UPDATE email_requests SET attempts = attempts + 1, status = ? WHERE id = ?")
      .bind(failed ? "failed" : row.status, row.id).run();
    if (failed) throw new HttpError(400, "too_many_attempts", "Too many wrong codes, so this sign-in was cancelled. Start again.");
    throw new HttpError(400, "wrong_code", "That code is not right. Check the email and try again.");
  }
  return c.json(await complete(c.env, row, row.status, c.var.deps.now()));
});

emailRoutes.post("/poll", limit(RULES.pollIp, ipKey), async (c) => {
  const body = await readJson(c, requestRef);
  const row = await requestFor(c.env, body, c.var.deps.now());
  if (row.status === "pending") return c.json({ status: "pending" });
  if (row.status !== "approved") throw expired();
  return c.json(await complete(c.env, row, "approved", c.var.deps.now()));
});

async function pendingByLink(env: AppEnv, token: string, now: number): Promise<RequestRow> {
  const row = await env.DB.prepare("SELECT * FROM email_requests WHERE link_hash = ?").bind(await sha256Hex(token)).first<RequestRow>();
  if (!row || row.status !== "pending" || row.expires_at <= now) throw expired();
  return row;
}

async function requestFor(env: AppEnv, ref: z.infer<typeof requestRef>, now: number): Promise<RequestRow> {
  const row = await env.DB.prepare("SELECT * FROM email_requests WHERE id = ?").bind(ref.requestId).first<RequestRow>();
  if (!row || !safeEqual(await sha256Hex(ref.pollSecret), row.poll_hash)) throw new HttpError(404, "not_found", "No such sign-in request.");
  if (row.expires_at <= now) throw expired();
  return row;
}

/** Turns a confirmed request into an account (on first sign-in), a device and a session, once. */
async function complete(env: AppEnv, row: RequestRow, from: string, now: number) {
  const claimed = await env.DB.prepare("UPDATE email_requests SET status = 'done' WHERE id = ? AND status = ?").bind(row.id, from).run();
  if (claimed.meta.changes !== 1) throw expired();
  const account = await accountForEmail(env, row.email, now);
  const device = check(deviceSchema, { name: row.device_name, kind: row.device_kind, publicKey: row.device_public_key });
  const session = await createDeviceSession(env, account.id, device, now);
  return { status: "signed_in", ...session, newAccount: account.created };
}

/** The right number and two others, with the right one in a random place. */
function choicesFor(match: number): number[] {
  const choices = new Set([match]);
  while (choices.size < 3) choices.add(10 + (randomBytes(1)[0]! % 90));
  const list = [...choices];
  const shift = randomBytes(1)[0]! % 3;
  return [...list.slice(shift), ...list.slice(0, shift)];
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The token rides in the URL fragment, which browsers never send to a server or write to its logs. */
function signInEmail(env: AppEnv, to: string, deviceName: string, token: string, code: string) {
  const link = `${env.API_ORIGIN}/v1/auth/email/confirm#${token}`;
  const text = [
    `Someone asked to sign in to Perch on "${deviceName}".`,
    "",
    `To sign in, open this link and pick the number Perch shows: ${link}`,
    "",
    `Or type this code in Perch: ${code}`,
    "",
    "The link and code work for 15 minutes. If this was not you, ignore this email; nothing changes.",
  ].join("\n");
  const html = `<p>Someone asked to sign in to Perch on “${escapeHtml(deviceName)}”.</p>
<p><a href="${escapeHtml(link)}">Sign in to Perch</a>, then pick the number Perch shows.</p>
<p>Or type this code in Perch: <strong style="font-family:monospace">${code}</strong></p>
<p>The link and code work for 15 minutes. If this was not you, ignore this email; nothing changes.</p>`;
  return { to, subject: "Sign in to Perch", text, html };
}
