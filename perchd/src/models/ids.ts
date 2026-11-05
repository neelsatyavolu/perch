/** The names Settings → Models works with: providers, task roles and effort levels (spec 7.3). */

export const PROVIDER_IDS = [
  "codex", "claude-code", "grok",
  "anthropic", "openai", "xai", "gemini", "openrouter",
  "custom", "lmstudio", "ollama",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Aside's task model roles, in the order the settings page shows them. */
export const ROLES = ["default", "fast", "standard", "deep", "visual", "image"] as const;
export type Role = (typeof ROLES)[number];

/** The effort a role asks for; each provider maps it to what its API accepts. */
export const ROLE_EFFORTS = ["off", "low", "medium", "high", "max"] as const;
export type RoleEffort = (typeof ROLE_EFFORTS)[number];

export const isProviderId = (value: unknown): value is ProviderId => PROVIDER_IDS.includes(value as ProviderId);
export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);
export const isRoleEffort = (value: unknown): value is RoleEffort => ROLE_EFFORTS.includes(value as RoleEffort);

export type ModelRef = { provider: ProviderId; model: string };
export type RoleChoice = ModelRef & { effort?: RoleEffort; fast?: boolean };
