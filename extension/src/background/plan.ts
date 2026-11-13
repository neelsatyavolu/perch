/** Pure functions that turn settings into what Chrome should have registered. */

import type { Rule } from "../rules/compile";
import { PRIORITY } from "../rules/limits";
import { FILTER_RULESET_IDS } from "../rules/rulesets";
import type { Settings } from "../shared/settings";

export const SITE_OFF_RULE_ID = 1;

/** The dynamic rule behind "protections off for this site": it outranks every block and redirect. */
export function siteOffRules(sitesOff: readonly string[]): Rule[] {
  if (sitesOff.length === 0) return [];
  return [
    {
      id: SITE_OFF_RULE_ID,
      priority: PRIORITY.siteOff,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: [...sitesOff], resourceTypes: ["main_frame", "sub_frame"] },
    },
  ];
}

export function enabledRulesets(settings: Settings): { enable: string[]; disable: string[] } {
  const want: Record<string, boolean> = { ...Object.fromEntries(FILTER_RULESET_IDS.map((id) => [id, settings.blocker])), params: settings.params };
  return {
    enable: Object.keys(want).filter((id) => want[id]),
    disable: Object.keys(want).filter((id) => !want[id]),
  };
}

export type ScriptPlan = {
  id: string;
  matches: string[];
  excludeMatches?: string[];
  allFrames: boolean;
  runAt: "document_start" | "document_end" | "document_idle";
} & ({ js: string[]; css?: string[] } | { js?: string[]; css: string[] });

const WEB = ["http://*/*", "https://*/*"];

export const GENERIC_CSS_ID = "perch-cosmetic";

const hostPatterns = (hosts: readonly string[]) => hosts.flatMap((host) => [`*://${host}/*`, `*://*.${host}/*`]);

/**
 * Content scripts exist only while their feature is on, so a page pays nothing for a feature that
 * is off. Cookie-banner rejection and element hiding are protections and stay away from sites the
 * user exempted; generic element hiding also stays off the sites the lists mark $generichide.
 */
export function contentScriptPlan(settings: Settings, genericExempt: readonly string[] = []): ScriptPlan[] {
  const exempt = hostPatterns(settings.sitesOff);
  const plan: ScriptPlan[] = [];
  if (settings.blocker) {
    const excluded = [...new Set([...exempt, ...hostPatterns(genericExempt)])];
    plan.push({
      id: GENERIC_CSS_ID,
      css: ["cosmetic/generic.css"],
      matches: WEB,
      ...(excluded.length ? { excludeMatches: excluded } : {}),
      allFrames: true,
      runAt: "document_start",
    });
  }
  if (settings.banners) {
    plan.push({
      id: "perch-banners",
      js: ["content/banners.js"],
      matches: WEB,
      ...(exempt.length ? { excludeMatches: exempt } : {}),
      allFrames: true,
      runAt: "document_idle",
    });
  }
  if (settings.pip) plan.push({ id: "perch-pip", js: ["content/pip.js"], matches: WEB, allFrames: true, runAt: "document_idle" });
  if (settings.speedKeys) plan.push({ id: "perch-speed", js: ["content/speed.js"], matches: WEB, allFrames: true, runAt: "document_idle" });
  if (settings.linkPreview) plan.push({ id: "perch-preview", js: ["content/preview.js"], matches: WEB, allFrames: false, runAt: "document_idle" });
  return plan;
}
