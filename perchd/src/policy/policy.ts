/**
 * Company policies (spec 12.2) as perchd enforces them. Only forced values count, the ones an MDM
 * profile sets, as in Chromium; a value a user sets with `defaults write` is ignored. A forced
 * value that fails its schema is dropped and reported, never half-applied. With no policy every
 * helper returns what the person chose, so an unmanaged Mac behaves exactly as before.
 */

import type { Mode } from "../agent/permissions";
import { DEFAULT_API } from "../sync/api";
import { CATALOGUE, CHROME_POLICIES, type CatalogueEntry } from "./catalogue";
import { check } from "./schema";

export type PolicyValue = { name: string; value: unknown; forced: boolean };
export interface PolicySource {
  read(names: readonly string[]): PolicyValue[];
}

export type ModelEndpoint = { name: string; kind: "openai" | "anthropic"; url: string; keyRef?: string };
export type PolicySiteRule = { pattern: string; rule: "never" | "ask" };

export type Policy = {
  readonly AgentEnabled?: boolean;
  readonly AllowedModelProviders?: readonly string[];
  readonly AllowedModels?: readonly string[];
  readonly ModelEndpoints?: readonly ModelEndpoint[];
  readonly MaxPermissionMode?: Mode;
  readonly AgentSiteRules?: readonly PolicySiteRule[];
  readonly MemoryEnabled?: boolean;
  readonly HistoryExtractionEnabled?: boolean;
  readonly MCPServerEnabled?: boolean;
  readonly AllowedMCPClients?: readonly string[];
  readonly RemoteControlEnabled?: boolean;
  readonly SyncEnabled?: boolean;
  readonly SyncServerURL?: string;
  readonly ImportEnabled?: { readonly browsers?: readonly string[]; readonly data?: readonly string[] };
  readonly BuiltInExtensions?: { readonly backrow?: boolean; readonly memorySaver?: boolean };
  readonly TelemetryEnabled?: false;
  readonly AuditLogPath?: string;
  readonly AutoUpdateEnabled?: boolean;
  readonly UpdateChannel?: "stable" | "beta";
  readonly UpdateDelayDays?: number;
  readonly MinimumVersion?: string;
  /** Chrome's own policy: true turns Perch's sync off too. */
  readonly SyncDisabled?: boolean;
};

export type PolicyError = { name: string; message: string };
export type Resolved = { policy: Policy; errors: PolicyError[] };

export const AGENT_OFF = "Your organization turned off the agent.";
export const MODEL_NOT_ALLOWED = "Your organization doesn't allow this model.";
export const CLIENTS_OFF = "Your organization doesn't allow outside agents.";
export const MANAGED = "Managed by your organization";

/** A change a company policy does not allow; perchd answers it with 403 and the message. */
export class ManagedError extends Error {
  override readonly name = "ManagedError";
  constructor(message: string = MANAGED) {
    super(message);
  }
}

const ALL: readonly CatalogueEntry[] = [...CATALOGUE, ...CHROME_POLICIES];

export function resolve(values: readonly PolicyValue[], catalogue: readonly CatalogueEntry[] = ALL): Resolved {
  const policy: Record<string, unknown> = {};
  const errors: PolicyError[] = [];
  for (const { name, value, forced } of values) {
    const entry = catalogue.find((c) => c.name === name);
    if (!entry || !forced || value === undefined || value === null) continue;
    const r = check(value, entry.schema, name);
    if (!r.ok) {
      errors.push({ name, message: `${r.message}, so Perch ignores it` });
      continue;
    }
    // A policy can only keep telemetry off; true means "not set".
    if (name === "TelemetryEnabled" && r.value === true) continue;
    policy[name] = r.value;
  }
  return { policy: policy as Policy, errors };
}

export const isManaged = (policy: Policy): boolean => Object.keys(policy).length > 0;

const ORDER: readonly Mode[] = ["ask", "guard", "skip"];

/** The mode a chat or client may use: its own, lowered to the company's cap. */
export function capMode(mode: Mode, policy: Policy): Mode {
  const max = policy.MaxPermissionMode;
  return max && ORDER.indexOf(mode) > ORDER.indexOf(max) ? max : mode;
}

/** Whether a mode is above the company's cap. */
export const aboveCap = (mode: Mode, policy: Policy): boolean => capMode(mode, policy) !== mode;

export const agentAllowed = (policy: Policy): boolean => policy.AgentEnabled !== false;

export function allowsModel(provider: string, model: string, policy: Policy): boolean {
  if (policy.AllowedModelProviders && !policy.AllowedModelProviders.includes(provider)) return false;
  return !policy.AllowedModels || policy.AllowedModels.includes(`${provider}/${model}`);
}

export const allowsProvider = (provider: string, policy: Policy): boolean => !policy.AllowedModelProviders || policy.AllowedModelProviders.includes(provider);

/** Whether an outside client may connect: the sidebar's own runs are not outside clients. */
export function allowsClient(name: string, policy: Policy): boolean {
  if (policy.MCPServerEnabled === false) return false;
  return !policy.AllowedMCPClients || policy.AllowedMCPClients.includes(name);
}

export const memoryAllowed = (policy: Policy): boolean => policy.MemoryEnabled !== false;
export const historyExtractionAllowed = (policy: Policy): boolean => memoryAllowed(policy) && policy.HistoryExtractionEnabled !== false;
export const remoteControlAllowed = (policy: Policy): boolean => policy.RemoteControlEnabled !== false;
export const syncAllowed = (policy: Policy): boolean => policy.SyncEnabled !== false && policy.SyncDisabled !== true;
export const telemetryAllowed = (policy: Policy): boolean => policy.TelemetryEnabled !== false;

export const syncBaseUrl = (policy: Policy): string => policy.SyncServerURL ?? DEFAULT_API;

export function importAllowed(browser: string, dataType: string, policy: Policy): boolean {
  const rule = policy.ImportEnabled;
  if (!rule) return true;
  return (!rule.browsers || rule.browsers.includes(browser)) && (!rule.data || rule.data.includes(dataType));
}

/**
 * Whether a host falls under a site pattern in Lulltab's forms (src/app/validate.ts sitePattern):
 * `bank.com` (and subdomains), `=host` (exact), `*.host` (subdomains only), `host/path` and full URLs.
 */
export function siteMatches(pattern: string, hostRaw: string): boolean {
  const host = hostRaw.toLowerCase();
  let p = pattern.trim().toLowerCase();
  if (/^https?:\/\//.test(p)) {
    try {
      p = new URL(p).hostname;
    } catch {
      return false;
    }
  }
  const exact = p.startsWith("=");
  const bare = (exact ? p.slice(1) : p).split("/")[0] ?? "";
  if (!bare) return false;
  if (exact) return host === bare;
  if (bare.startsWith("*.")) return host.endsWith(bare.slice(1));
  return host === bare || host.endsWith(`.${bare}`);
}

type SiteRule = "allow" | "ask" | "never";

/**
 * The rule for a site: the company's rule wins over the person's own, and "never" cannot be
 * loosened. A person's stricter rule still applies (their "never" beats a company "ask").
 */
export function siteRuleFor(host: string, userRule: SiteRule | undefined, policy: Policy): SiteRule | undefined {
  const rules = (policy.AgentSiteRules ?? []).filter((r) => siteMatches(r.pattern, host));
  if (rules.some((r) => r.rule === "never")) return "never";
  if (rules.length) return userRule === "never" ? "never" : "ask";
  return userRule;
}

/** A view of the current policy; perchd passes the watcher's, tests pass a fixed one. */
export type PolicyView = { current(): Policy };
export const fixedPolicy = (policy: Policy = {}): PolicyView => ({ current: () => policy });
