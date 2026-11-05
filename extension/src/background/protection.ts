/** Makes Chrome's state match the settings: rulesets, the per-site rule and registered content scripts. */

import type { Settings } from "../shared/settings";
import { contentScriptPlan, enabledRulesets, siteOffRules } from "./plan";

export async function applySettings(settings: Settings): Promise<void> {
  await Promise.all([applyRules(settings), applyContentScripts(settings)]);
}

async function applyRules(settings: Settings): Promise<void> {
  const { enable, disable } = enabledRulesets(settings);
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: siteOffRules(settings.sitesOff) as chrome.declarativeNetRequest.Rule[],
  });
}

async function applyContentScripts(settings: Settings): Promise<void> {
  const ours = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).filter((id) => id.startsWith("perch-"));
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
  const plan = contentScriptPlan(settings);
  if (plan.length) await chrome.scripting.registerContentScripts(plan.map((s) => ({ ...s, persistAcrossSessions: true })));
}
