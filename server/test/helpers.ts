import { env } from "cloudflare:test";
import { createApp } from "../src/app";
import type { AppEnv } from "../src/env";
import { captureMailer } from "../src/mailer";
import { toBase64Url } from "../src/crypto";

export const appEnv = env as unknown as AppEnv;

let counter = 0;
/** A fresh IP per caller, so one test's rate limits never touch another's. */
export const freshIp = () => `10.${(counter >> 8) & 255}.${counter++ & 255}.${Math.floor(Math.random() * 250) + 1}`;
export const freshEmail = (name = "person") => `${name}.${Date.now()}.${counter++}@example.com`;

export type CallOptions = { body?: unknown; token?: string; ip?: string; headers?: Record<string, string>; raw?: BodyInit };
export type Called = { status: number; data: any; res: Response };

/** The app with a capture mailer and a clock tests can move. */
export function harness(start = Date.now()) {
  const clock = { now: start };
  const mailer = captureMailer();
  const app = createApp({ mailer, now: () => clock.now });
  const ip = freshIp();
  async function call(method: string, path: string, options: CallOptions = {}): Promise<Called> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    headers.set("cf-connecting-ip", options.ip ?? ip);
    const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const res = await app.fetch(new Request(`https://api.perchbrowser.com${path}`, { method, headers, body }), appEnv);
    const type = res.headers.get("content-type") ?? "";
    const data = res.status === 101 ? null : type.includes("json") ? await res.json() : type.includes("octet-stream") ? new Uint8Array(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data, res };
  }
  return { app, mailer, clock, call, ip };
}
export type Harness = ReturnType<typeof harness>;

/** A device key pair like the one perchd keeps in the Keychain. */
export async function deviceKeys(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicKey: toBase64Url(raw), privateKey: pair.privateKey };
}

export async function device(name = "Neel’s MacBook Pro", kind = "browser") {
  return { name, kind, publicKey: (await deviceKeys()).publicKey };
}

export const codeFrom = (text: string) => /type this code in Perch: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(text)?.[1] ?? "";
export const linkTokenFrom = (text: string) => /#(elk_[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";

export type Session = { sessionToken: string; accountId: string; deviceId: string };

/** Asks for a fresh email confirmation and reads the code from the captured email. */
export async function confirmation(h: Harness, s: Session, action: "delete_account" | "add_passkey") {
  const res = await h.call("POST", "/v1/account/confirm", { token: s.sessionToken, body: { action } });
  if (res.status !== 200) throw new Error(`confirm failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { confirmationId: res.data.confirmationId as string, code: codeFrom(h.mailer.sent.at(-1)!.text) };
}

/** Signs a new device in by email code, creating the account the first time. */
export async function signIn(h: Harness, email = freshEmail(), dev?: { name: string; kind: string; publicKey: string }): Promise<Session> {
  const start = await h.call("POST", "/v1/auth/email/start", { body: { email, device: dev ?? (await device()) } });
  if (start.status !== 200) throw new Error(`start failed: ${start.status} ${JSON.stringify(start.data)}`);
  const mail = h.mailer.sent.at(-1)!;
  const verified = await h.call("POST", "/v1/auth/email/verify", {
    body: { requestId: start.data.requestId, pollSecret: start.data.pollSecret, code: codeFrom(mail.text) },
  });
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status} ${JSON.stringify(verified.data)}`);
  return { sessionToken: verified.data.sessionToken, accountId: verified.data.accountId, deviceId: verified.data.deviceId };
}
