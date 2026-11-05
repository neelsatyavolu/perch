/**
 * The six task model roles from Aside's Models page (spec 7.3): Default, Fast, Standard, Deep,
 * Visual and Image generation. Each resolves to a model the user can reach right now: their own
 * choice when it still works, otherwise the best connected provider's model for that role, with a
 * note saying why it changed.
 */

import type { Settings } from "../config/store";
import { describeModel, type ModelInfo } from "./catalog";
import type { ProviderId, Role, RoleChoice, RoleEffort } from "./ids";
import { ROLES } from "./ids";
import { PROVIDERS, ProviderError } from "./providers";

/** Connected providers and the models each offers (empty when its list is unknown). */
export type Availability = ReadonlyMap<ProviderId, readonly ModelInfo[]>;

export type ResolvedRole = {
  role: Role;
  provider: ProviderId;
  model: string;
  info: ModelInfo;
  effort?: RoleEffort;
  fast?: boolean;
  source: "chosen" | "default" | "fallback";
  note?: string;
};

/** Which provider fills a role when the user has not chosen [builder call]: subscriptions first. */
export const PREFERENCE: readonly ProviderId[] = ["codex", "claude-code", "grok", "anthropic", "openai", "xai", "gemini", "openrouter", "custom", "lmstudio", "ollama"];

/** Why a model cannot take a role, or null when it can. */
function unfit(role: Role, provider: ProviderId, info: ModelInfo): string | null {
  const def = PROVIDERS[provider];
  if (role === "image") return info.imageOutput && def.images ? null : `${info.label} cannot make images.`;
  if (def.chat === "runner" && role === "visual") return "Claude Code runs whole tasks, so it cannot be the Visual model.";
  if (role === "visual" && !info.vision) return `${info.label} cannot read images.`;
  if (!info.tools) return `${info.label} cannot use Perch's tools.`;
  return null;
}

function lookup(provider: ProviderId, model: string, available: Availability): ModelInfo | null {
  const list = available.get(provider);
  if (!list) return null;
  // Runners and providers without a model list accept any id; their metadata comes from the catalog.
  if (list.length === 0) return describeModel(provider, model);
  return list.find((m) => m.id === model) ?? null;
}

function candidate(role: Role, provider: ProviderId, available: Availability): ModelInfo | null {
  const preset = PROVIDERS[provider].defaults[role];
  if (preset) {
    const info = (available.get(provider) ?? []).find((m) => m.id === preset) ?? describeModel(provider, preset);
    return unfit(role, provider, info) ? null : info;
  }
  return (available.get(provider) ?? []).find((m) => !unfit(role, provider, m)) ?? null;
}

const keepEffort = (info: ModelInfo, effort?: RoleEffort) => (effort && info.efforts.includes(effort) ? { effort } : {});

function fallback(role: Role, available: Availability): { provider: ProviderId; info: ModelInfo } | null {
  for (const provider of PREFERENCE) {
    if (!available.has(provider)) continue;
    const info = candidate(role, provider, available);
    if (info) return { provider, info };
  }
  return null;
}

function whyNot(choice: RoleChoice, role: Role, available: Availability): string {
  const label = PROVIDERS[choice.provider].label;
  if (!available.has(choice.provider)) return `${label} is not connected`;
  const info = lookup(choice.provider, choice.model, available);
  if (!info) return `${choice.model} is no longer offered by ${label}`;
  return (unfit(role, choice.provider, info) ?? "").replace(/\.$/, "");
}

export function resolveRole(role: Role, settings: Settings, available: Availability): ResolvedRole | null {
  const choice = settings.roles[role];
  if (choice) {
    const info = lookup(choice.provider, choice.model, available);
    if (info && !unfit(role, choice.provider, info)) {
      return { role, provider: choice.provider, model: choice.model, info, ...keepEffort(info, choice.effort), ...(choice.fast !== undefined ? { fast: choice.fast } : {}), source: "chosen" };
    }
  }
  const found = fallback(role, available);
  if (!found) return null;
  const base: ResolvedRole = { role, provider: found.provider, model: found.info.id, info: found.info, source: choice ? "fallback" : "default" };
  return choice ? { ...base, note: `${whyNot(choice, role, available)}, so ${found.info.label} is used.` } : base;
}

export function resolveRoles(settings: Settings, available: Availability): Record<Role, ResolvedRole | null> {
  return Object.fromEntries(ROLES.map((role) => [role, resolveRole(role, settings, available)])) as Record<Role, ResolvedRole | null>;
}

/** Checks a choice from the settings page before it is saved; throws a plain explanation. */
export function validateRoleChoice(role: Role, choice: RoleChoice, available: Availability): RoleChoice {
  const label = PROVIDERS[choice.provider].label;
  if (!available.has(choice.provider)) throw new ProviderError(`Connect ${label} first.`, "not-connected");
  const info = lookup(choice.provider, choice.model, available);
  if (!info) throw new ProviderError(`${label} does not offer ${choice.model}.`);
  const problem = unfit(role, choice.provider, info);
  if (problem) throw new ProviderError(problem, "unsupported");
  if (choice.effort && choice.effort !== "off" && !info.efforts.includes(choice.effort)) {
    throw new ProviderError(`${info.label} does not take a "${choice.effort}" effort setting.`, "unsupported");
  }
  return { provider: choice.provider, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.fast !== undefined ? { fast: choice.fast } : {}) };
}
