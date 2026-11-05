/** Rule priorities and Chrome's declarativeNetRequest limits, in one place. */

export const PRIORITY = {
  /** Ordinary block filters. */
  block: 1,
  /** Tracking-parameter redirects run below exceptions too. */
  params: 1,
  /** `@@` exceptions. */
  allow: 2,
  /** `$important` filters beat exceptions, as in Adblock Plus. */
  important: 3,
  /** `@@...$important`. */
  importantAllow: 4,
  /** The user's "protections off for this site" switch beats everything. */
  siteOff: 100,
} as const;

/** Static rules Chrome guarantees every extension (GUARANTEED_MINIMUM_STATIC_RULES). */
export const STATIC_RULE_BUDGET = 30_000;

/** Dynamic rules allowed per extension (MAX_NUMBER_OF_DYNAMIC_RULES, the safe-rule figure). */
export const DYNAMIC_RULE_LIMIT = 5_000;

export type ResourceType = `${chrome.declarativeNetRequest.ResourceType}`;

export const ALL_RESOURCE_TYPES: readonly ResourceType[] = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
];

/**
 * Block rules count up from 1 and exceptions from ALLOW_ID_BASE, so the site panel can count
 * blocked requests from getMatchedRules without loading the rulesets.
 */
export const ALLOW_ID_BASE = 1_000_000;

export function isBlockRuleId(id: number): boolean {
  return id < ALLOW_ID_BASE;
}
