/**
 * Settings → Models over the model registry (src/models/registry.ts). The pages name providers a
 * little differently: "chatgpt" is the registry's "codex", and "local" stands for its three
 * endpoint providers (any OpenAI-compatible server, LM Studio and Ollama). Keys go in through
 * setKey and connectEndpoint; only "Key ending abcd" comes back.
 */

import type { Model, Provider, ProviderId as PageProvider, TaskModel, TaskRole } from "../../../../ui-pages/src/api";
import { PROVIDER_IDS, ROLE_EFFORTS, ROLES, type ProviderId, type RoleChoice } from "../../models/ids";
import { PROVIDERS, ProviderError, secretName } from "../../models/providers";
import type { ModelRegistry, ProviderStatus } from "../../models/registry";
import { AppError } from "../runs";
import * as v from "../validate";
import type { Methods } from "./common";
import type { PagesDeps } from "./deps";

const ENDPOINTS: readonly ProviderId[] = ["custom", "lmstudio", "ollama"];
const KEY_PROVIDERS = ["anthropic", "openai", "xai", "gemini", "openrouter"] as const;
const PAGE_IDS: readonly PageProvider[] = ["claude-code", "chatgpt", "grok", "anthropic", "openai", "xai", "gemini", "openrouter", "local"];
const SIGN_IN_POLL_MS = 1000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const DETAIL: Record<PageProvider, string> = {
  "claude-code": "Uses the Claude Code you signed in to on this Mac.",
  chatgpt: "Sign in with your ChatGPT plan.",
  grok: "Sign in with your Grok plan.",
  anthropic: "Paste an Anthropic API key.",
  openai: "Paste an OpenAI API key.",
  xai: "Paste an xAI API key.",
  gemini: "Paste a Google Gemini API key.",
  openrouter: "Paste an OpenRouter API key.",
  local: "LM Studio, Ollama, or any OpenAI-compatible server.",
};
const NAMES: Record<PageProvider, string> = {
  "claude-code": "Claude Code", chatgpt: "ChatGPT", grok: "Grok", anthropic: "Anthropic", openai: "OpenAI",
  xai: "xAI", gemini: "Google Gemini", openrouter: "OpenRouter", local: "Local or custom endpoint",
};

const toPage = (id: ProviderId): PageProvider => (id === "codex" ? "chatgpt" : ENDPOINTS.includes(id) ? "local" : (id as PageProvider));
const fromPage = (id: PageProvider): ProviderId => (id === "chatgpt" ? "codex" : id === "local" ? "custom" : id);
const modelId = (provider: ProviderId, model: string) => `${provider}:${model}`;

function parseModelId(value: string): { provider: ProviderId; model: string } {
  const at = value.indexOf(":");
  const provider = value.slice(0, at) as ProviderId;
  if (at <= 0 || !PROVIDER_IDS.includes(provider) || !value.slice(at + 1)) throw new AppError("That model isn't available");
  return { provider, model: value.slice(at + 1) };
}

/** Errors the registry raises are written for the person; anything else is not. */
async function registryCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProviderError) throw new AppError(error.message);
    throw error;
  }
}

export function modelsPages(deps: PagesDeps): Methods<"listProviders" | "signIn" | "signOut" | "connectProvider" | "listModels" | "getTaskModels" | "setTaskModel"> {
  const registry = () => deps.models.registry();

  async function keyHint(id: ProviderId): Promise<string | undefined> {
    const key = await deps.models.keychain.get(secretName(id)).catch(() => null);
    return key ? `Key ending ${key.slice(-4)}` : undefined;
  }

  async function view(page: PageProvider, all: readonly ProviderStatus[]): Promise<Provider> {
    const base = { id: page, name: NAMES[page], detail: DETAIL[page] };
    if (page === "local") {
      const on = all.find((s) => ENDPOINTS.includes(s.id) && s.connected);
      const kind = "local" as const;
      if (!on) return { ...base, kind, state: "signed-out" };
      const host = on.baseUrl && URL.canParse(on.baseUrl) ? new URL(on.baseUrl).host : PROVIDERS[on.id].label;
      return { ...base, kind, state: "connected", account: host };
    }
    const s = all.find((x) => x.id === fromPage(page))!;
    const kind = s.kind === "subscription" ? ("subscription" as const) : ("api-key" as const);
    if (s.state === "not-installed") return { ...base, kind, state: "not-installed", message: "Install Claude Code and sign in to it once in Terminal." };
    if (s.state === "expired") return { ...base, kind, state: "error", message: `Your ${NAMES[page]} sign-in expired. Sign in again.` };
    if (!s.connected) return { ...base, kind, state: "signed-out" };
    const account = s.connect === "key" ? await keyHint(s.id) : undefined;
    return { ...base, kind, state: "connected", ...(account ? { account } : {}) };
  }

  async function provider(page: PageProvider): Promise<Provider> {
    return view(page, await (await registry()).listProviders());
  }

  async function waitForSignIn(r: ModelRegistry, id: ProviderId): Promise<void> {
    const until = Date.now() + (deps.models.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
    while (Date.now() < until) {
      if ((await r.listProviders()).find((s) => s.id === id)?.connected) return;
      await Bun.sleep(SIGN_IN_POLL_MS);
    }
    throw new AppError(`The ${PROVIDERS[id].label} sign-in didn't finish. Try again, and finish signing in on the page that opens.`, 408);
  }

  async function connected(): Promise<ProviderId[]> {
    return (await (await registry()).listProviders()).filter((s) => s.connected).map((s) => s.id);
  }

  async function currentChoice(role: TaskRole): Promise<RoleChoice | null> {
    const resolved = (await (await registry()).getRoles())[role];
    return resolved ? { provider: resolved.provider, model: resolved.model, ...(resolved.effort ? { effort: resolved.effort } : {}), ...(resolved.fast !== undefined ? { fast: resolved.fast } : {}) } : null;
  }

  /** The six roles as resolved now; a role without an effort of its own shows "medium". */
  async function taskModels(): Promise<TaskModel[]> {
    const roles = await (await registry()).getRoles();
    return ROLES.map((role): TaskModel => {
      const r = roles[role];
      return { role, modelId: r ? modelId(r.provider, r.model) : null, effort: r?.effort ?? "medium", fast: r?.fast ?? false };
    });
  }

  return {
    async listProviders() {
      const all = await (await registry()).listProviders();
      return Promise.all(PAGE_IDS.map((id) => view(id, all)));
    },
    async signIn([raw]) {
      const page = v.oneOf(raw, "id", PAGE_IDS);
      const id = fromPage(page);
      const r = await registry();
      if (id === "claude-code") await registryCall(() => r.connectClaudeCode());
      else if (id === "codex" || id === "grok") {
        const { url } = await registryCall(() => r.startSignIn(id));
        await deps.models.openUrl(url);
        await waitForSignIn(r, id);
      } else throw new AppError(`${NAMES[page]} connects with a key or an endpoint`);
      return provider(page);
    },
    async signOut([raw]) {
      const page = v.oneOf(raw, "id", PAGE_IDS);
      const r = await registry();
      const ids = page === "local" ? ENDPOINTS : [fromPage(page)];
      for (const id of ids) await registryCall(() => r.signOut(id));
      return provider(page);
    },
    async connectProvider([input]) {
      const o = v.object(input, '"input"');
      const r = await registry();
      if (o.kind === "api-key") {
        v.onlyKeys(o, ["kind", "provider", "key"]);
        const page = v.oneOf(o.provider, "provider", KEY_PROVIDERS);
        await registryCall(() => r.setKey(page, v.text(o.key, "key", 1000)));
        return provider(page);
      }
      if (o.kind !== "endpoint") throw new AppError('"kind" must be one of api-key, endpoint');
      v.onlyKeys(o, ["kind", "name", "baseUrl", "key"]);
      if (!v.text(o.name, "name", 60).trim()) throw new AppError("Give it a name");
      const baseUrl = v.text(o.baseUrl, "baseUrl", 2000).trim();
      const key = v.optionalText(o.key, "key", 1000);
      await registryCall(() => r.connectEndpoint("custom", { baseUrl, key: key?.trim() ? key : null }));
      return provider("local");
    },
    async listModels() {
      const r = await registry();
      const lists = await Promise.all(
        (await connected()).map(async (id) => (await r.listModels(id).catch(() => [])).map((m): Model => ({
          id: modelId(id, m.id), label: m.label, provider: toPage(id), vision: m.vision, imageGeneration: m.imageOutput,
        }))),
      );
      return lists.flat();
    },
    getTaskModels: () => taskModels(),
    async setTaskModel([rawRole, rawPatch]) {
      const role = v.oneOf(rawRole, "role", ROLES);
      const o = v.object(rawPatch, '"patch"');
      v.onlyKeys(o, ["modelId", "effort", "fast"]);
      const effort = o.effort === undefined ? undefined : v.oneOf(o.effort, "effort", ROLE_EFFORTS);
      const fast = o.fast === undefined ? undefined : v.bool(o.fast, "fast");
      const r = await registry();
      if (o.modelId === null) await registryCall(() => r.setRole(role, null));
      else {
        const picked = o.modelId === undefined ? await currentChoice(role) : parseModelId(v.text(o.modelId, "modelId", 300));
        if (!picked) throw new AppError("Pick a model for this task first");
        const current = await currentChoice(role);
        const kept = current && current.provider === picked.provider && current.model === picked.model ? current : null;
        const e = effort ?? kept?.effort;
        const f = fast ?? kept?.fast;
        const choice: RoleChoice = { provider: picked.provider, model: picked.model, ...(e ? { effort: e } : {}), ...(f !== undefined ? { fast: f } : {}) };
        await registryCall(() => r.setRole(role, choice));
      }
      return (await taskModels()).find((t) => t.role === role)!;
    },
  };
}
