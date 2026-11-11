/**
 * ChatGPT, Grok and Claude (Pro or Max) sign-in through `@neelsatyavolu/shared-ai-auth` (spec
 * 7.3), the same flow Flint uses: PKCE, a localhost callback (or the pasted address or code),
 * tokens in the Keychain, refresh shortly before expiry. Claude has no localhost callback: its page
 * shows `code#state` to paste. Tokens never appear in errors, logs or settings files.
 */

import { authorizeUrl, exchangeCode, generatePkce, parseCallback, refreshTokens, type PKCE, type Tokens } from "@neelsatyavolu/shared-ai-auth";
import type { Keychain } from "../config/keychain";
import { startLoopback, type LoopbackHandle, type LoopbackStarter } from "./loopback";
import { PROVIDERS, ProviderError, secretName } from "./providers";
import type { ResponsesTokens } from "./responses";

export type SubscriptionId = "codex" | "grok" | "claude";
export type SignInStatus = "signed-in" | "signed-out" | "expired";

const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_AHEAD_MS = 30_000;
/** Ports and paths fixed by each CLI's OAuth registration (see shared-ai-auth's redirect URIs). */
const CALLBACK: Partial<Record<SubscriptionId, { port: number; path: string }>> = {
  codex: { port: 1455, path: "/auth/callback" },
  grok: { port: 56121, path: "/callback" },
};

export type SubscriptionAuthOptions = {
  keychain: Keychain;
  fetch?: typeof fetch;
  now?: () => number;
  /** null turns the localhost listener off (paste only). */
  loopback?: LoopbackStarter | null;
  ports?: Partial<Record<SubscriptionId, number>>;
  onChange?: (provider: SubscriptionId) => void;
};

type Pending = { pkce: PKCE; expiresAt: number };

function parseStored(raw: string | null): Tokens | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    const ok = typeof t?.accessToken === "string" && t.accessToken && typeof t.refreshToken === "string" && t.refreshToken && typeof t.expiresAt === "number";
    return ok ? { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, ...(t.idToken ? { idToken: String(t.idToken) } : {}), ...(t.accountId ? { accountId: String(t.accountId) } : {}) } : null;
  } catch {
    return null;
  }
}

const label = (p: SubscriptionId) => PROVIDERS[p].label;
const signInAgain = (p: SubscriptionId) => `Sign in to ${label(p)} again in Settings → Models.`;

export function createSubscriptionAuth(opts: SubscriptionAuthOptions) {
  const now = opts.now ?? Date.now;
  const starter = opts.loopback === undefined ? startLoopback : opts.loopback;
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  let pending = new Map<SubscriptionId, Pending>();
  let listeners = new Map<SubscriptionId, LoopbackHandle>();
  // The refresh token the provider rejected, per provider. Tokens saved after that (a new
  // sign-in, here or in another Perch process) end the expired state on their own.
  let expired = new Map<SubscriptionId, string>();
  let refreshing = new Map<SubscriptionId, Promise<Tokens>>();
  // Bumped by sign-out, so a token request still in flight cannot save tokens afterwards.
  let generations = new Map<SubscriptionId, number>();
  const generation = (p: SubscriptionId) => generations.get(p) ?? 0;

  const stored = async (p: SubscriptionId) => parseStored(await opts.keychain.get(secretName(p)));
  async function save(p: SubscriptionId, t: Tokens, since: number): Promise<void> {
    if (generation(p) !== since) throw new ProviderError(`Signed out of ${label(p)}.`, "not-connected");
    await opts.keychain.set(secretName(p), JSON.stringify(t));
  }
  const without = <K, V>(map: Map<K, V>, key: K) => new Map([...map].filter(([k]) => k !== key));

  function live(p: SubscriptionId): Pending | null {
    const attempt = pending.get(p);
    if (attempt && attempt.expiresAt > now()) return attempt;
    pending = without(pending, p);
    return null;
  }

  function stopListener(p: SubscriptionId): void {
    const handle = listeners.get(p);
    listeners = without(listeners, p);
    handle?.close();
  }

  async function complete(p: SubscriptionId, code: string, verifier: string, state?: string): Promise<void> {
    const since = generation(p);
    let tokens: Tokens;
    try {
      tokens = await exchangeCode(p, code, verifier, { ...fetchOpt, ...(state ? { state } : {}) });
    } catch {
      throw new ProviderError(`Perch could not finish signing in to ${label(p)}. Start again from Settings → Models.`, "auth");
    }
    // Cancelled or replaced while the code was being exchanged: keep nothing.
    if (pending.get(p)?.pkce.verifier !== verifier) throw new ProviderError(`That ${label(p)} sign-in was cancelled. Start again from Settings → Models.`);
    await save(p, tokens, since);
    pending = without(pending, p);
    expired = without(expired, p);
    opts.onChange?.(p);
  }

  const isExpired = (p: SubscriptionId, t: Tokens) => expired.get(p) === t.refreshToken;

  function listen(p: SubscriptionId): boolean {
    const callback = CALLBACK[p];
    if (!starter || !callback) return false;
    const { port, path } = callback;
    const handle = starter({
      port: opts.ports?.[p] ?? port,
      path,
      ttlMs: PENDING_TTL_MS,
      handle: async (url) => {
        const attempt = live(p);
        const cb = parseCallback(url.search);
        if (!attempt || cb.state !== attempt.pkce.state) return { ok: false, ignore: true };
        if (cb.error || !cb.code) return { ok: false };
        await complete(p, cb.code, attempt.pkce.verifier, cb.state);
        return { ok: true };
      },
      onClose: () => {
        if (listeners.get(p) === handle) listeners = without(listeners, p);
      },
    });
    if (handle) listeners = new Map(listeners).set(p, handle);
    return handle !== null;
  }

  /** Starts a sign-in: open `url` in a tab. `needsPaste` means the page will show a code or address to paste. */
  async function startSignIn(p: SubscriptionId): Promise<{ url: string; needsPaste: boolean }> {
    const pkce = generatePkce();
    pending = new Map(pending).set(p, { pkce, expiresAt: now() + PENDING_TTL_MS });
    stopListener(p);
    const listening = listen(p);
    // Grok's page may show a bare code instead of redirecting, so it always offers the paste box.
    return { url: authorizeUrl(p, pkce), needsPaste: p === "grok" || !listening };
  }

  async function finishSignIn(p: SubscriptionId, pasted: string): Promise<void> {
    const attempt = live(p);
    if (!attempt) throw new ProviderError(`That ${label(p)} sign-in expired. Start again from Settings → Models.`);
    const cb = parseCallback(String(pasted ?? "").slice(0, 4096));
    if (cb.error) throw new ProviderError(`The ${label(p)} sign-in was declined. Start again from Settings → Models.`, "auth");
    if (!cb.code) throw new ProviderError("Paste the whole address from the browser, or the code the page shows.");
    // A bare code carries no state; it binds to the attempt Perch started.
    if (cb.state !== null && cb.state !== attempt.pkce.state) throw new ProviderError("That address belongs to a different sign-in. Start again from Settings → Models.");
    // Claude's token endpoint needs the state too, so its whole `code#state` must be pasted.
    if (p === "claude" && cb.state === null) throw new ProviderError("Paste the whole code the Claude page shows, including the part after #.");
    await complete(p, cb.code, attempt.pkce.verifier, cb.state ?? undefined);
    stopListener(p);
  }

  /** Status of a failed token request, from shared-ai-auth's "… token request failed (NNN)". */
  const failedStatus = (error: unknown): number | null => {
    const m = /\((\d{3})\)/.exec(String((error as Error)?.message));
    return m ? Number(m[1]) : null;
  };

  async function refresh(p: SubscriptionId, current: Tokens): Promise<Tokens> {
    const inflight = refreshing.get(p);
    if (inflight) return inflight;
    const since = generation(p);
    const run = (async () => {
      let next: Tokens;
      try {
        next = await refreshTokens(p, current.refreshToken, { ...fetchOpt, previous: current });
      } catch (error) {
        // Only 400 (invalid_grant) and 401 mean the refresh token is dead. A 429, a timeout or a
        // server error leaves the sign-in as it is; the next request tries again.
        const status = failedStatus(error);
        if (status !== 400 && status !== 401) {
          throw new ProviderError(`Perch could not reach ${label(p)} to renew the sign-in. Check your connection and try again.`, "unreachable");
        }
        // Another Perch process may have rotated the tokens first, spending this refresh token.
        const latest = await stored(p);
        if (latest && latest.refreshToken !== current.refreshToken) {
          if (latest.expiresAt > now() + REFRESH_AHEAD_MS) return latest;
          refreshing = without(refreshing, p);
          return refresh(p, latest);
        }
        expired = new Map(expired).set(p, current.refreshToken);
        opts.onChange?.(p);
        throw new ProviderError(signInAgain(p), "auth");
      }
      await save(p, next, since);
      return next;
    })();
    refreshing = new Map(refreshing).set(p, run);
    try {
      return await run;
    } finally {
      if (refreshing.get(p) === run) refreshing = without(refreshing, p);
    }
  }

  /** Current tokens for the Responses adapter, refreshed first when they are about to expire. */
  async function tokens(p: SubscriptionId): Promise<ResponsesTokens> {
    const current = await stored(p);
    if (!current) throw new ProviderError(`Sign in to ${label(p)} in Settings → Models first.`, "not-connected");
    if (isExpired(p, current)) throw new ProviderError(signInAgain(p), "auth");
    const fresh = current.expiresAt > now() + REFRESH_AHEAD_MS ? current : await refresh(p, current);
    return { accessToken: fresh.accessToken, ...(fresh.accountId ? { accountId: fresh.accountId } : {}) };
  }

  async function status(p: SubscriptionId): Promise<SignInStatus> {
    const current = await stored(p);
    if (!current) return "signed-out";
    return isExpired(p, current) ? "expired" : "signed-in";
  }

  async function signOut(p: SubscriptionId): Promise<void> {
    generations = new Map(generations).set(p, generation(p) + 1);
    pending = without(pending, p);
    stopListener(p);
    expired = without(expired, p);
    await opts.keychain.delete(secretName(p));
    opts.onChange?.(p);
  }

  return {
    startSignIn,
    finishSignIn,
    tokens,
    status,
    signOut,
    listenerPort: (p: SubscriptionId) => listeners.get(p)?.port ?? null,
    dispose: () => {
      for (const p of [...listeners.keys()]) stopListener(p);
      pending = new Map();
    },
  };
}

export type SubscriptionAuth = ReturnType<typeof createSubscriptionAuth>;
