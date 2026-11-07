/**
 * Settings → Permissions: the default mode for new chats, site rules and each outside client's
 * mode (the daemon's ClientRegistry). A company's MaxPermissionMode (spec 12.2) is `maxMode`, and
 * a mode above it is refused here, not only greyed out in the page. The activity log is audit.ts.
 */

import type { PermissionMode, Permissions } from "../../../../ui-pages/src/api";
import { AppError } from "../runs";
import * as v from "../validate";
import { aboveCap, capMode } from "../../policy/policy";
import { gone, managed, plainly, policyOf, type Methods } from "./common";
import type { PagesDeps } from "./deps";

const MODES: readonly PermissionMode[] = ["ask", "guard", "skip"];
const RULES = ["allow", "ask", "never"] as const;
const MAX_RULES = 1000;

export function permissionsPages(deps: PagesDeps): Methods<"getPermissions" | "setPermissionMode" | "addSiteRule" | "removeSiteRule" | "setClientMode"> {
  async function permissions(): Promise<Permissions> {
    const s = await deps.state.get();
    const clientRules = deps.clients.list()
      .filter((c) => !c.revoked)
      .map((c) => ({ id: c.name, client: c.name, mode: capMode(c.mode, policyOf(deps)), ...(c.lastUsed ? { lastUsed: c.lastUsed } : {}) }));
    const maxMode = policyOf(deps).MaxPermissionMode ?? null;
    return { mode: maxMode ? capMode(s.mode, policyOf(deps)) : s.mode, siteRules: s.siteRules, clientRules, maxMode };
  }

  /** A mode above the company's cap is refused here, so the page's greyed-out row cannot be stepped around. */
  const requireWithinCap = (mode: PermissionMode) => {
    if (aboveCap(mode, policyOf(deps))) managed();
  };

  return {
    getPermissions: () => permissions(),
    async setPermissionMode([mode]) {
      const clean = v.oneOf(mode, "mode", MODES);
      requireWithinCap(clean);
      await deps.state.update((s) => ({ ...s, mode: clean }));
      deps.setDefaults?.({ mode: clean });
      return permissions();
    },
    async addSiteRule([input]) {
      const o = v.object(input, '"input"');
      v.onlyKeys(o, ["pattern", "rule"]);
      const pattern = v.sitePattern(o.pattern);
      const rule = v.oneOf(o.rule, "rule", RULES);
      await deps.state.update((s) => {
        if (s.siteRules.some((r) => r.pattern === pattern)) return { ...s, siteRules: s.siteRules.map((r) => (r.pattern === pattern ? { ...r, rule } : r)) };
        if (s.siteRules.length >= MAX_RULES) throw new AppError(`You can keep up to ${MAX_RULES} site rules. Remove one first.`);
        return { ...s, siteRules: [...s.siteRules, { id: `rule-${crypto.randomUUID()}`, pattern, rule }] };
      });
      return permissions();
    },
    async removeSiteRule([id]) {
      const clean = v.id(id, "id");
      await deps.state.update((s) => ({ ...s, siteRules: s.siteRules.filter((r) => r.id !== clean) }));
      return permissions();
    },
    async setClientMode([id, mode]) {
      const name = v.id(id, "id");
      const clean = v.oneOf(mode, "mode", MODES);
      requireWithinCap(clean);
      if (!deps.clients.list().some((c) => c.name === name && !c.revoked)) gone("That client is no longer connected to Perch");
      await plainly(() => deps.clients.setMode(name, clean));
      return permissions();
    },
  };
}
