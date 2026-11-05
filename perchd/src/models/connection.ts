/**
 * Talking to a provider without running a model: list its models, which doubles as the
 * connection test for API keys and local servers, and check that Claude Code is installed.
 */

import { claudeBinary } from "../external";
import { parseModelList, type ModelInfo } from "./catalog";
import { redactSecrets } from "./http";
import type { ProviderId } from "./ids";
import { PROVIDERS, ProviderError } from "./providers";

const LIST_TIMEOUT_MS = 10_000;

export type ConnectionResult = { ok: true; message: string; models: number; latencyMs: number } | { ok: false; message: string; code: ProviderError["code"] };
export type ListContext = { provider: ProviderId; baseUrl: string; credential: string | null; fetch: typeof fetch };

export const connectedMessage = (count: number): string => (count > 0 ? `Connected. ${count} model${count === 1 ? "" : "s"}.` : "Connected.");

function request(ctx: ListContext): { url: string; headers: Record<string, string> } {
  const base = ctx.baseUrl.replace(/\/+$/, "");
  if (ctx.provider === "anthropic") return { url: `${base}/models?limit=100`, headers: { "x-api-key": ctx.credential ?? "", "anthropic-version": "2023-06-01" } };
  if (ctx.provider === "gemini") return { url: `${base}/models?pageSize=200`, headers: { "x-goog-api-key": ctx.credential ?? "" } };
  return { url: `${base}/models`, headers: ctx.credential ? { authorization: `Bearer ${ctx.credential}` } : {} };
}

/** OpenRouter lists models without a key, so its key is checked on its own endpoint first. */
async function verifyOpenRouterKey(ctx: ListContext): Promise<void> {
  if (ctx.provider !== "openrouter" || !ctx.credential) return;
  try {
    const res = await ctx.fetch(`${ctx.baseUrl.replace(/\/+$/, "")}/key`, { headers: { authorization: `Bearer ${ctx.credential}` }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) throw new ProviderError("OpenRouter rejected that key. Check it and try again.", "auth");
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Could not reach OpenRouter. Check your connection.", "unreachable");
  }
}

/** The provider's live model list. Throws a ProviderError in plain words on any failure. */
export async function fetchModelList(ctx: ListContext): Promise<ModelInfo[]> {
  const def = PROVIDERS[ctx.provider];
  await verifyOpenRouterKey(ctx);
  const { url, headers } = request(ctx);
  let res: Response;
  try {
    res = await ctx.fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch {
    const hint = def.kind === "local" ? "Check that it is running and the address is right." : "Check your connection.";
    throw new ProviderError(`Could not reach ${def.label}. ${hint}`, "unreachable");
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(def.auth === "oauth" ? `Sign in to ${def.label} again in Settings → Models.` : `${def.label} rejected that key. Check it and try again.`, "auth");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const message = JSON.parse(text)?.error?.message;
      if (typeof message === "string") detail = ` ${redactSecrets(message).slice(0, 300)}`;
    } catch {
      /* not JSON */
    }
    throw new ProviderError(`${def.label} answered with an error (HTTP ${res.status}).${detail}`, "invalid");
  }
  try {
    return parseModelList(ctx.provider, JSON.parse(text));
  } catch {
    throw new ProviderError(`${def.label} sent a model list Perch could not read. Check the address.`, "invalid");
  }
}

export type ClaudeCodeProbe = () => Promise<{ installed: boolean; version?: string }>;

/** Finds the installed Claude Code CLI and asks its version. Never reads its sign-in. */
export const probeClaudeCode: ClaudeCodeProbe = async () => {
  let bin: string;
  try {
    bin = claudeBinary();
  } catch {
    return { installed: false };
  }
  try {
    const child = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), 10_000);
    const out = await new Response(child.stdout).text();
    clearTimeout(timer);
    const code = await child.exited;
    const version = out.match(/\d+\.\d+\.\d+/)?.[0];
    return code === 0 ? { installed: true, ...(version ? { version } : {}) } : { installed: false };
  } catch {
    return { installed: false };
  }
};
