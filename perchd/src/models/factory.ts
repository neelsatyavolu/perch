/** Builds the adapter for a provider and model: a chat Model, the Claude Code runner, or an image generator. */

import { anthropicModel } from "./anthropic";
import { chatCompletionsModel } from "./chat-completions";
import type { ProviderId, RoleEffort } from "./ids";
import type { ImageGeneratorOptions } from "./images";
import { PROVIDERS, ProviderError } from "./providers";
import { responsesModel, type ResponsesTokens } from "./responses";
import type { Effort, Model } from "./types";

export type AdapterDeps = {
  baseUrl: string;
  /** API key, or null for endpoints without one. Read at each turn so a changed key takes effect. */
  apiKey: () => Promise<string | null>;
  /** Sign-in tokens for ChatGPT and Grok. */
  oauthTokens: () => Promise<ResponsesTokens>;
  fetch: typeof fetch;
};

/**
 * Maps a role's effort to what the provider's API takes; undefined sends none. The catalog only
 * offers a model the efforts that map to something here (see test/effort.test.ts).
 */
export function adapterEffort(provider: ProviderId, effort: RoleEffort | undefined): Effort | undefined {
  if (!effort) return undefined;
  const chat = PROVIDERS[provider].chat;
  // The Claude Code runner has no effort setting.
  if (chat === "runner") return undefined;
  const openai = provider === "codex" || provider === "openai";
  if (effort === "off") return openai ? "none" : undefined;
  if (effort !== "max") return effort;
  // The Claude API takes max; OpenAI's top level is xhigh; xAI and Chat Completions servers stop at high.
  return chat === "anthropic" ? "max" : openai ? "xhigh" : "high";
}

const requireKey = (deps: AdapterDeps, label: string) => async (): Promise<string> => {
  const key = await deps.apiKey();
  if (!key) throw new ProviderError(`Add a ${label} key in Settings → Models.`, "not-connected");
  return key;
};

/** `fast` asks for the provider's fast mode; only the Claude API takes it so far. */
export function buildChatModel(provider: ProviderId, model: string, deps: AdapterDeps, extra: { fast?: boolean } = {}): Model {
  const def = PROVIDERS[provider];
  const base = deps.baseUrl.replace(/\/+$/, "");
  switch (provider) {
    case "anthropic":
      return anthropicModel({ model, apiKey: requireKey(deps, def.label), url: `${base}/messages`, ...(extra.fast ? { fast: true } : {}) }, deps.fetch);
    case "codex":
    case "grok":
      return responsesModel({ provider, model, getToken: deps.oauthTokens, url: `${base}/responses` }, deps.fetch);
    case "openai":
    case "xai": {
      const key = requireKey(deps, def.label);
      const getToken = async () => ({ accessToken: await key() });
      return responsesModel({ provider: provider === "openai" ? "openai" : "grok", model, getToken, url: `${base}/responses`, label: def.label }, deps.fetch);
    }
    case "gemini":
      return chatCompletionsModel({ provider, model, baseUrl: `${base}/openai`, apiKey: deps.apiKey, effortParam: "reasoning_effort" }, deps.fetch);
    case "openrouter":
      return chatCompletionsModel(
        { provider, model, baseUrl: base, apiKey: deps.apiKey, effortParam: "reasoning", headers: { "HTTP-Referer": "https://perchbrowser.com", "X-Title": "Perch" } },
        deps.fetch,
      );
    case "custom":
      return chatCompletionsModel({ provider, model, baseUrl: base, apiKey: deps.apiKey, effortParam: "reasoning_effort" }, deps.fetch);
    case "lmstudio":
    case "ollama":
      return chatCompletionsModel({ provider, model, baseUrl: base, apiKey: deps.apiKey }, deps.fetch);
    case "claude-code":
      throw new ProviderError("Claude Code runs whole tasks; use it as a runner.", "unsupported");
  }
}

export function imageOptions(provider: ProviderId, model: string, deps: AdapterDeps): ImageGeneratorOptions {
  const def = PROVIDERS[provider];
  if (!def.images) throw new ProviderError(`${def.label} cannot make images.`, "unsupported");
  const key = requireKey(deps, def.label);
  const credential = async () => {
    if (def.auth !== "oauth") return { token: await key() };
    const t = await deps.oauthTokens();
    return { token: t.accessToken, ...(t.accountId ? { accountId: t.accountId } : {}) };
  };
  return {
    api: def.images,
    model,
    ...(def.images === "codex" && def.defaults.fast ? { hostModel: def.defaults.fast } : {}),
    baseUrl: deps.baseUrl,
    credential,
    fetch: deps.fetch,
  };
}
