import type { RateLimiter } from "./ratelimit";
import type { RelayRoom } from "./relay";

/** Bindings and settings from wrangler.jsonc. RESEND_API_KEY is a Worker secret, never a var. */
export type AppEnv = {
  DB: D1Database;
  BLOBS: R2Bucket;
  RELAY: DurableObjectNamespace<RelayRoom>;
  LIMITER: DurableObjectNamespace<RateLimiter>;
  API_ORIGIN: string;
  RELAY_ORIGIN: string;
  RP_ID: string;
  RP_NAME: string;
  PASSKEY_ORIGINS: string;
  MAIL_FROM: string;
  QUOTA_BYTES: string;
  RESEND_API_KEY?: string;
};

export type Auth = { accountId: string; deviceId: string; kind: string };

/** Hono's environment type for this app. */
export type HonoEnv = {
  Bindings: AppEnv;
  Variables: { auth: Auth; deps: Deps };
};

export type Mailer = {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
};

/** Things the routes need that tests replace. */
export type Deps = { mailer: Mailer; now: () => number };

export const quotaBytes = (env: AppEnv): number => {
  const value = Number(env.QUOTA_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : 100 * 1024 * 1024;
};

export const passkeyOrigins = (env: AppEnv): string[] =>
  env.PASSKEY_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
