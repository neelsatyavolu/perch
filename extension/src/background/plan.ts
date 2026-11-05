/** Pure functions that turn settings into what Chrome should have registered. */

import type { Rule } from "../rules/compile";
import { PRIORITY } from "../rules/limits";
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
  const want: Record<string, boolean> = { easylist: settings.blocker, easyprivacy: settings.blocker, params: settings.params };
  return {
    enable: Object.keys(want).filter((id) => want[id]),
    disable: Object.keys(want).filter((id) => !want[id]),
  };
}

export type ScriptPlan = {
  id: string;
  js: string[];
  matches: string[];
  excludeMatches?: string[];
  allFrames: boolean;
  runAt: "document_start" | "document_end" | "document_idle";
};

const WEB = ["http://*/*", "https://*/*"];

/**
 * Content scripts exist only while their feature is on, so a page pays nothing for a feature that
 * is off. Cookie-banner rejection is a protection and stays away from sites the user exempted.
 */
export function contentScriptPlan(settings: Settings): ScriptPlan[] {
  const exempt = settings.sitesOff.flatMap((host) => [`*://${host}/*`, `*://*.${host}/*`]);
  const plan: ScriptPlan[] = [];
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
