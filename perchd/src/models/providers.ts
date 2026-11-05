/**
 * The providers Settings → Models can connect (spec 7.3), with the models each one fills the task
 * roles with when the user has not chosen. Default model ids were checked against each provider's
 * documentation on 2026-11-05; live model lists replace them wherever the provider has one.
 */

import type { ProviderId, Role } from "./ids";

export type ProviderKind = "subscription" | "api" | "local";
/** How a provider is connected: OAuth sign-in, the installed CLI, an API key, or a local server. */
export type ProviderAuth = "oauth" | "cli" | "key" | "endpoint";
/** Which adapter talks to the provider's chat API. */
export type ChatApi = "anthropic" | "responses" | "chat-completions" | "runner";
export type ImageApi = "openai" | "xai" | "gemini" | "codex";

export type ProviderDef = {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  auth: ProviderAuth;
  chat: ChatApi;
  images?: ImageApi;
  /** API root; local and custom providers can change it. */
  baseUrl: string;
  /** An endpoint provider whose key is optional (LM Studio and Ollama need none). */
  keyOptional?: boolean;
  defaults: Partial<Record<Role, string>>;
};

const CLAUDE = { default: "claude-opus-5-5", deep: "claude-opus-5-5", standard: "claude-sonnet-5-5", fast: "claude-haiku-5-5" };
const GPT = { default: "gpt-6-astra", deep: "gpt-6-astra", standard: "gpt-6.1-sol", fast: "gpt-6-luna", visual: "gpt-6.1-sol", image: "gpt-image-2.5-sunburst" };
const GROK = { default: "grok-4.7", deep: "grok-4.7", standard: "grok-4.7", fast: "grok-4.7", visual: "grok-4.7", image: "grok-imagine-image-2.0" };

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDef>> = Object.freeze({
  codex: { id: "codex", label: "ChatGPT", kind: "subscription", auth: "oauth", chat: "responses", images: "codex", baseUrl: "https://chatgpt.com/backend-api/codex", defaults: GPT },
  "claude-code": { id: "claude-code", label: "Claude Code", kind: "subscription", auth: "cli", chat: "runner", baseUrl: "", defaults: CLAUDE },
  grok: { id: "grok", label: "Grok", kind: "subscription", auth: "oauth", chat: "responses", images: "xai", baseUrl: "https://api.x.ai/v1", defaults: GROK },
  anthropic: { id: "anthropic", label: "Anthropic", kind: "api", auth: "key", chat: "anthropic", baseUrl: "https://api.anthropic.com/v1", defaults: { ...CLAUDE, visual: "claude-sonnet-5-5" } },
  openai: { id: "openai", label: "OpenAI", kind: "api", auth: "key", chat: "responses", images: "openai", baseUrl: "https://api.openai.com/v1", defaults: GPT },
  xai: { id: "xai", label: "xAI", kind: "api", auth: "key", chat: "responses", images: "xai", baseUrl: "https://api.x.ai/v1", defaults: GROK },
  gemini: {
    id: "gemini", label: "Google Gemini", kind: "api", auth: "key", chat: "chat-completions", images: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaults: { default: "gemini-3.1-pro-preview", deep: "gemini-3.1-pro-preview", standard: "gemini-3.8-flash", fast: "gemini-3.5-flash-lite", visual: "gemini-3.8-flash", image: "gemini-nano-banana-2.1" },
  },
  openrouter: { id: "openrouter", label: "OpenRouter", kind: "api", auth: "key", chat: "chat-completions", baseUrl: "https://openrouter.ai/api/v1", defaults: { default: "openrouter/auto", deep: "openrouter/auto", standard: "openrouter/auto", fast: "openrouter/auto" } },
  custom: { id: "custom", label: "OpenAI-compatible endpoint", kind: "api", auth: "endpoint", chat: "chat-completions", baseUrl: "", keyOptional: true, defaults: {} },
  lmstudio: { id: "lmstudio", label: "LM Studio", kind: "local", auth: "endpoint", chat: "chat-completions", baseUrl: "http://127.0.0.1:1234/v1", keyOptional: true, defaults: {} },
  ollama: { id: "ollama", label: "Ollama", kind: "local", auth: "endpoint", chat: "chat-completions", baseUrl: "http://127.0.0.1:11434/v1", keyOptional: true, defaults: {} },
});

/** The Keychain item for a provider's API key or sign-in tokens. */
export const secretName = (id: ProviderId): string => (PROVIDERS[id].auth === "oauth" ? `oauth:${id}` : `api-key:${id}`);

export class ProviderError extends Error {
  constructor(message: string, readonly code: "invalid" | "auth" | "unreachable" | "not-connected" | "unsupported" = "invalid") {
    super(message);
    this.name = "ProviderError";
  }
}

/** Trims a pasted key and checks its shape. The message never repeats the key. */
export function checkApiKey(raw: string): string {
  const key = String(raw ?? "").trim();
  if (key.length < 16) throw new ProviderError("That key is too short. Copy the whole key from the provider's site.");
  if (key.length > 512) throw new ProviderError("That key is too long. Copy only the key.");
  if (/\s/.test(key)) throw new ProviderError("That key has spaces or line breaks in it. Copy only the key.");
  if (!/^[\x21-\x7e]+$/.test(key)) throw new ProviderError("That key has characters a key cannot have. Copy it again.");
  return key;
}
