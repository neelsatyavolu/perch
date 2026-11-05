import { DurableObject } from "cloudflare:workers";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, HonoEnv } from "./env";
import { HttpError } from "./http";
import { sha256Hex } from "./crypto";

/** A token bucket: `capacity` requests at once, refilled evenly over `seconds`. */
export type Rule = { name: string; capacity: number; seconds: number };

/**
 * Limits for every endpoint (spec 11.4: abuse limits on sign-up, pairing and relay traffic).
 * Sized for one person's devices; a bucket refills fully over its window.
 */
export const RULES = {
  publicIp: { name: "public-ip", capacity: 600, seconds: 60 },
  emailStartIp: { name: "email-start-ip", capacity: 10, seconds: 3600 },
  emailStartAddress: { name: "email-start-address", capacity: 5, seconds: 3600 },
  emailVerifyIp: { name: "email-verify-ip", capacity: 30, seconds: 600 },
  passkeyIp: { name: "passkey-ip", capacity: 30, seconds: 60 },
  account: { name: "account", capacity: 600, seconds: 60 },
  syncWrite: { name: "sync-write", capacity: 120, seconds: 60 },
  pairStartIp: { name: "pair-start-ip", capacity: 10, seconds: 600 },
  pairLookup: { name: "pair-lookup", capacity: 10, seconds: 600 },
  pollIp: { name: "poll-ip", capacity: 240, seconds: 600 },
  relayConnect: { name: "relay-connect", capacity: 30, seconds: 60 },
} as const satisfies Record<string, Rule>;

type Bucket = { tokens: number; at: number };

/** One bucket per Durable Object, named by a hash of the rule and the key. */
export class RateLimiter extends DurableObject<AppEnv> {
  take(capacity: number, seconds: number, now = Date.now()): { ok: boolean; retryAfter: number } {
    const rate = capacity / (seconds * 1000);
    const saved = this.ctx.storage.kv.get<Bucket>("bucket");
    const tokens = saved ? Math.min(capacity, saved.tokens + (now - saved.at) * rate) : capacity;
    if (tokens < 1) {
      this.ctx.storage.kv.put("bucket", { tokens, at: now });
      return { ok: false, retryAfter: Math.ceil((1 - tokens) / rate / 1000) };
    }
    this.ctx.storage.kv.put("bucket", { tokens: tokens - 1, at: now });
    return { ok: true, retryAfter: 0 };
  }
}

/** Takes one token for `rule` and `key`, or throws 429 with Retry-After. */
export async function consume(env: AppEnv, rule: Rule, key: string): Promise<void> {
  const name = await sha256Hex(`${rule.name}:${key}`);
  const stub = env.LIMITER.get(env.LIMITER.idFromName(name));
  const result = await stub.take(rule.capacity, rule.seconds);
  if (!result.ok) {
    throw new HttpError(429, "rate_limited", `Too many requests. Try again in ${result.retryAfter} seconds.`, {
      "Retry-After": String(result.retryAfter),
    });
  }
}

/** Middleware form of consume, with the key taken from the request. */
export const limit =
  (rule: Rule, key: (c: Context<HonoEnv>) => string): MiddlewareHandler<HonoEnv> =>
  async (c, next) => {
    await consume(c.env, rule, key(c));
    await next();
  };
