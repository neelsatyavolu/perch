/**
 * The typed API behind Settings → Models (spec 7.3): providers to connect, their models, the six
 * task roles, a connection test, and the adapters the agent runs. Secrets go to the Keychain;
 * choices go to the encrypted settings store. Every input from the settings page is validated here.
 */

import { loadModels, type ModelCatalog } from "@neelsatyavolu/shared-ai-auth";
import type { Keychain } from "../config/keychain";
import { checkBaseUrl, SettingsError, type Settings, type SettingsStore } from "../config/store";
import { describeModel, type ModelInfo } from "./catalog";
import { connectedMessage, fetchModelList, probeClaudeCode, type ClaudeCodeProbe, type ConnectionResult } from "./connection";
import { adapterEffort, buildChatModel, imageOptions, type AdapterDeps } from "./factory";
import { isProviderId, isRole, PROVIDER_IDS, type ModelRef, type ProviderId, type Role, type RoleChoice } from "./ids";
import { generateImages, type ImageFile, type ImageRequest } from "./images";
import type { LoopbackStarter } from "./loopback";
import { createSubscriptionAuth, type SubscriptionId } from "./oauth";
import { checkApiKey, PROVIDERS, ProviderError, secretName, type ProviderAuth, type ProviderKind } from "./providers";
import { resolveRole, resolveRoles, validateRoleChoice, type Availability, type ResolvedRole } from "./roles";
import type { Effort, Model } from "./types";

const LIST_TTL_MS = 10 * 60_000;
const PROBE_TTL_MS = 60_000;
const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export type ProviderState = "connected" | "signed-out" | "expired" | "not-installed" | "not-set-up";
export type ProviderStatus = {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** What the settings page shows to connect it. */
  connect: "sign-in" | "install" | "key" | "endpoint";
  connected: boolean;
  state: ProviderState;
  baseUrl?: string;
  keyOptional: boolean;
  makesImages: boolean;
};
export type ModelHandle =
  | { kind: "model"; model: Model; effort?: Effort; info: ModelInfo; provider: ProviderId }
  | { kind: "runner"; runner: "claude-code"; model: string; info: ModelInfo; provider: "claude-code" };
export type Roles = Record<Role, ResolvedRole | null>;

export type RegistryOptions = {
  store: SettingsStore;
  keychain: Keychain;
  fetch?: typeof fetch;
  /** Overrides each provider's API root (tests; endpoints set by the user win over these). */
  urls?: Partial<Record<ProviderId, string>>;
  catalog?: () => Promise<ModelCatalog>;
  claudeCode?: ClaudeCodeProbe;
  loopback?: LoopbackStarter | null;
  now?: () => number;
  onChange?: () => void;
};

const CONNECT: Record<ProviderAuth, ProviderStatus["connect"]> = { oauth: "sign-in", cli: "install", key: "key", endpoint: "endpoint" };
const isSubscription = (id: ProviderId): id is SubscriptionId => id === "codex" || id === "grok";

function checkProvider(id: unknown): ProviderId {
  if (!isProviderId(id)) throw new ProviderError("Unknown provider.");
  return id;
}

export function createModelRegistry(opts: RegistryOptions) {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const probe = opts.claudeCode ?? probeClaudeCode;
  const subs = createSubscriptionAuth({ keychain: opts.keychain, fetch: fetchImpl, now, loopback: opts.loopback, onChange: () => invalidate() });
  let lists = new Map<ProviderId, { at: number; models: ModelInfo[] }>();
  let catalogCache: { at: number; value: Promise<ModelCatalog> } | null = null;
  let probeCache: { at: number; value: Promise<{ installed: boolean; version?: string }> } | null = null;

  function invalidate(id?: ProviderId): void {
    lists = id ? new Map([...lists].filter(([k]) => k !== id)) : new Map();
    opts.onChange?.();
  }

  const settings = (): Settings => opts.store.get();
  const baseUrl = (id: ProviderId): string => settings().providers[id]?.baseUrl ?? opts.urls?.[id] ?? PROVIDERS[id].baseUrl;
  const secret = (id: ProviderId) => opts.keychain.get(secretName(id));

  function claudeCode() {
    if (!probeCache || now() - probeCache.at > PROBE_TTL_MS) probeCache = { at: now(), value: probe() };
    return probeCache.value;
  }

  function catalog(): Promise<ModelCatalog> {
    if (!catalogCache || now() - catalogCache.at > LIST_TTL_MS) {
      catalogCache = { at: now(), value: (opts.catalog ?? (() => loadModels({ fetch: fetchImpl })))() };
    }
    return catalogCache.value;
  }

  const deps = (id: ProviderId): AdapterDeps => ({
    baseUrl: baseUrl(id),
    apiKey: () => (PROVIDERS[id].auth === "oauth" ? Promise.resolve(null) : secret(id)),
    oauthTokens: () => (isSubscription(id) ? subs.tokens(id) : Promise.reject(new ProviderError("Not a sign-in provider."))),
    fetch: fetchImpl,
  });

  async function state(id: ProviderId): Promise<ProviderState> {
    const def = PROVIDERS[id];
    const flagged = settings().providers[id]?.connected === true;
    if (isSubscription(id)) {
      const s = await subs.status(id);
      return s === "signed-in" ? "connected" : s;
    }
    if (def.auth === "cli") {
      if (!(await claudeCode()).installed) return "not-installed";
      return flagged ? "connected" : "not-set-up";
    }
    if (!flagged) return "not-set-up";
    if (def.auth === "key" && !(await secret(id))) return "not-set-up";
    return "connected";
  }

  async function listProviders(): Promise<ProviderStatus[]> {
    return Promise.all(
      PROVIDER_IDS.map(async (id) => {
        const def = PROVIDERS[id];
        const s = await state(id);
        const url = def.auth === "endpoint" ? baseUrl(id) : undefined;
        return { id, label: def.label, kind: def.kind, connect: CONNECT[def.auth], connected: s === "connected", state: s, ...(url ? { baseUrl: url } : {}), keyOptional: Boolean(def.keyOptional), makesImages: Boolean(def.images) };
      }),
    );
  }

  /** Image models a provider makes, added to its list when the list leaves them out. */
  function withImageModels(id: ProviderId, models: ModelInfo[]): ModelInfo[] {
    const preset = PROVIDERS[id].images ? PROVIDERS[id].defaults.image : undefined;
    return preset && !models.some((m) => m.id === preset) ? [...models, describeModel(id, preset)] : models;
  }

  async function freshModels(id: ProviderId, credential?: string | null): Promise<ModelInfo[]> {
    if (id === "claude-code") return CLAUDE_MODELS.map((m) => describeModel(id, m));
    if (isSubscription(id)) {
      const entries = (await catalog())[id] ?? [];
      return withImageModels(id, entries.map((m) => ({ ...describeModel(id, m.id), label: m.label })));
    }
    const key = credential !== undefined ? credential : await secret(id);
    return withImageModels(id, await fetchModelList({ provider: id, baseUrl: baseUrl(id), credential: key, fetch: fetchImpl }));
  }

  async function listModels(idRaw: ProviderId): Promise<ModelInfo[]> {
    const id = checkProvider(idRaw);
    const cached = lists.get(id);
    if (cached && now() - cached.at < LIST_TTL_MS) return cached.models;
    const models = await freshModels(id);
    lists = new Map(lists).set(id, { at: now(), models });
    return models;
  }

  async function availability(): Promise<Availability> {
    const entries = await Promise.all(
      PROVIDER_IDS.map(async (id) => {
        if ((await state(id)) !== "connected") return null;
        try {
          return [id, await listModels(id)] as const;
        } catch (error) {
          // A rejected key or an unreachable provider cannot serve a role now, so others take over.
          const code = error instanceof ProviderError ? error.code : "unreachable";
          if (code === "auth" || code === "unreachable") return null;
          // Otherwise the list is unknown (an endpoint without /models), not empty.
          return [id, [] as ModelInfo[]] as const;
        }
      }),
    );
    return new Map(entries.filter((e): e is readonly [ProviderId, ModelInfo[]] => e !== null));
  }

  async function markConnected(id: ProviderId, patch: { connected: boolean; baseUrl?: string }): Promise<void> {
    await opts.store.update((s) => ({ ...s, providers: { ...s.providers, [id]: { ...(s.providers[id] ?? {}), ...patch } } }));
    invalidate(id);
  }

  async function check(id: ProviderId, credential?: string | null): Promise<ConnectionResult> {
    const started = now();
    try {
      const models = await freshModels(id, credential);
      return { ok: true, message: connectedMessage(models.length), models: models.length, latencyMs: now() - started };
    } catch (error) {
      const e = error instanceof ProviderError ? error : new ProviderError("The connection test failed.", "unreachable");
      return { ok: false, message: e.message, code: e.code };
    }
  }

  /** Saves an API key for a key provider, after checking it with the provider. */
  async function setKey(idRaw: ProviderId, raw: string): Promise<ConnectionResult> {
    const id = checkProvider(idRaw);
    const def = PROVIDERS[id];
    if (def.auth === "oauth") throw new ProviderError(`${def.label} signs in with an account, not a key.`);
    if (def.auth !== "key" && def.auth !== "endpoint") throw new ProviderError(`${def.label} does not use a key.`);
    if (def.auth === "endpoint") return connectEndpoint(id, { key: raw });
    const key = checkApiKey(raw);
    const result = await check(id, key);
    if (!result.ok) throw new ProviderError(result.message, result.code);
    await opts.keychain.set(secretName(id), key);
    await markConnected(id, { connected: true });
    return result;
  }

  /**
   * Connects a local server or custom endpoint: base URL and an optional key. Leaving `key` out
   * keeps the saved key (and checks the new address with it); `null` or "" removes it.
   */
  async function connectEndpoint(idRaw: ProviderId, input: { baseUrl?: string; key?: string | null }): Promise<ConnectionResult> {
    const id = checkProvider(idRaw);
    const def = PROVIDERS[id];
    if (def.auth !== "endpoint") throw new ProviderError(`${def.label} is not an endpoint provider.`);
    const address = input.baseUrl ?? baseUrl(id);
    if (!address) throw new ProviderError(`Give the ${def.label} base URL first.`);
    let url: string;
    try {
      url = checkBaseUrl(address);
    } catch (error) {
      throw new ProviderError(error instanceof SettingsError ? error.message : "The base URL is not valid.");
    }
    const key = input.key === undefined ? await secret(id) : input.key?.trim() ? checkApiKey(input.key) : null;
    const started = now();
    let models: ModelInfo[];
    try {
      models = await fetchModelList({ provider: id, baseUrl: url, credential: key, fetch: fetchImpl });
    } catch (error) {
      throw error instanceof ProviderError ? error : new ProviderError(`Could not reach ${def.label}.`, "unreachable");
    }
    if (key) await opts.keychain.set(secretName(id), key);
    else await opts.keychain.delete(secretName(id));
    await markConnected(id, { connected: true, baseUrl: url });
    return { ok: true, message: connectedMessage(models.length), models: models.length, latencyMs: now() - started };
  }

  async function connectClaudeCode(): Promise<ConnectionResult> {
    probeCache = null;
    const found = await claudeCode();
    if (!found.installed) throw new ProviderError("Install Claude Code, sign in to it once in Terminal, then connect it here.", "not-connected");
    await markConnected("claude-code", { connected: true });
    return { ok: true, message: `Connected to Claude Code${found.version ? ` ${found.version}` : ""}.`, models: CLAUDE_MODELS.length, latencyMs: 0 };
  }

  function subscription(idRaw: ProviderId): SubscriptionId {
    const id = checkProvider(idRaw);
    if (!isSubscription(id)) throw new ProviderError(`${PROVIDERS[id].label} connects with an API key or address, not a sign-in.`);
    return id;
  }

  async function signOut(idRaw: ProviderId): Promise<void> {
    const id = checkProvider(idRaw);
    if (isSubscription(id)) await subs.signOut(id);
    else if (PROVIDERS[id].auth !== "cli") await opts.keychain.delete(secretName(id));
    // Role choices stay, so reconnecting brings them back; resolution falls back meanwhile.
    await markConnected(id, { connected: false });
  }

  async function testConnection(idRaw: ProviderId): Promise<ConnectionResult> {
    const id = checkProvider(idRaw);
    if ((await state(id)) !== "connected") return { ok: false, message: `${PROVIDERS[id].label} is not connected.`, code: "not-connected" };
    if (id === "claude-code") {
      const found = await claudeCode();
      return found.installed ? { ok: true, message: "Claude Code is installed.", models: CLAUDE_MODELS.length, latencyMs: 0 } : { ok: false, message: "Claude Code is no longer installed.", code: "not-connected" };
    }
    if (id === "grok") {
      // Grok's models come from the shared catalog, so ask xAI directly with the sign-in.
      const started = now();
      try {
        const { accessToken } = await subs.tokens("grok");
        await fetchModelList({ provider: "grok", baseUrl: baseUrl("grok"), credential: accessToken, fetch: fetchImpl });
        const count = (await listModels("grok")).length;
        return { ok: true, message: connectedMessage(count), models: count, latencyMs: now() - started };
      } catch (error) {
        const e = error instanceof ProviderError ? error : new ProviderError("The connection test failed.", "unreachable");
        return { ok: false, message: e.message, code: e.code };
      }
    }
    if (id !== "codex") return check(id);
    // ChatGPT has no model list endpoint: send one tiny request with the fast model.
    const started = now();
    try {
      const model = buildChatModel(id, PROVIDERS.codex.defaults.fast ?? "gpt-6-luna", deps(id));
      for await (const _ of model.turn({ system: "Reply with OK.", messages: [{ role: "user", text: "ping" }], tools: [] }, AbortSignal.timeout(30_000))) {
        /* drain */
      }
      return { ok: true, message: "Connected.", models: (await listModels(id)).length, latencyMs: now() - started };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "The connection test failed.", code: error instanceof ProviderError ? error.code : "unreachable" };
    }
  }

  async function getRoles(): Promise<Roles> {
    return resolveRoles(settings(), await availability());
  }

  function checkChoice(choice: unknown): RoleChoice {
    const c = (choice ?? {}) as Record<string, unknown>;
    const provider = checkProvider(c.provider);
    if (typeof c.model !== "string" || !c.model.trim()) throw new ProviderError("Choose a model.");
    return { ...(c as RoleChoice), provider, model: c.model.trim() };
  }

  async function setRole(role: Role, choice: RoleChoice | null): Promise<Roles> {
    if (!isRole(role)) throw new ProviderError("Unknown role.");
    const available = await availability();
    const valid = choice === null ? null : validateRoleChoice(role, checkChoice(choice), available);
    await opts.store.update((s) => {
      const { [role]: _, ...rest } = s.roles;
      return { ...s, roles: valid ? { ...rest, [role]: valid } : rest };
    });
    opts.onChange?.();
    return resolveRoles(settings(), available);
  }

  /** The model a chat just used becomes the Default role, as on Aside. */
  async function noteUsed(ref: ModelRef): Promise<Roles> {
    const current = settings().roles.default;
    const same = current && current.provider === ref.provider && current.model === ref.model;
    if (same) return getRoles();
    return setRole("default", { provider: ref.provider, model: ref.model });
  }

  async function handleFor(resolved: ResolvedRole | { provider: ProviderId; model: string; info: ModelInfo; effort?: RoleChoice["effort"] }): Promise<ModelHandle> {
    if (resolved.provider === "claude-code") return { kind: "runner", runner: "claude-code", model: resolved.model, info: resolved.info, provider: "claude-code" };
    const effort = adapterEffort(resolved.provider, resolved.effort);
    return { kind: "model", model: buildChatModel(resolved.provider, resolved.model, deps(resolved.provider)), info: resolved.info, provider: resolved.provider, ...(effort ? { effort } : {}) };
  }

  /** The adapter for a role, or for a specific model from the picker. */
  async function modelFor(target: Exclude<Role, "image"> | RoleChoice): Promise<ModelHandle> {
    if (typeof target === "string") {
      // The settings page may send anything, so check at runtime too.
      if (!isRole(target) || (target as Role) === "image") throw new ProviderError("Use generateImage for the Image role.");
      const resolved = resolveRole(target, settings(), await availability());
      if (!resolved) throw new ProviderError("Connect a model provider in Settings → Models first.", "not-connected");
      return handleFor(resolved);
    }
    // A model from the picker must be offered and able to use Perch's tools, as for the Default role.
    const available = await availability();
    const choice = validateRoleChoice("default", checkChoice(target), available);
    const info = (available.get(choice.provider) ?? []).find((m) => m.id === choice.model) ?? describeModel(choice.provider, choice.model);
    return handleFor({ ...choice, info });
  }

  async function generateImage(req: ImageRequest & { ref?: ModelRef }): Promise<ImageFile[]> {
    const target = req.ref ? validateRoleChoice("image", checkChoice(req.ref), await availability()) : resolveRole("image", settings(), await availability());
    if (!target) throw new ProviderError("Connect ChatGPT, OpenAI, Grok, xAI or Google Gemini to make images.", "not-connected");
    return generateImages(imageOptions(target.provider, target.model, deps(target.provider)), req);
  }

  return {
    listProviders,
    startSignIn: async (id: ProviderId) => subs.startSignIn(subscription(id)),
    finishSignIn: async (id: ProviderId, pasted: string) => {
      await subs.finishSignIn(subscription(id), pasted);
      invalidate(id);
    },
    connectClaudeCode,
    setKey,
    connectEndpoint,
    signOut,
    listModels,
    testConnection,
    getRoles,
    setRole,
    noteUsed,
    modelFor,
    generateImage,
    dispose: subs.dispose,
  };
}

export type ModelRegistry = ReturnType<typeof createModelRegistry>;
