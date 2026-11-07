/**
 * Settings → Permissions: the default mode for new chats, site rules, each outside client's mode
 * (the daemon's ClientRegistry) and the audit log, read from every log perchd writes. No company
 * policy caps the mode yet, so `maxMode` is null.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuditEntry, AuditOutcome, PermissionMode, Permissions } from "../../../../ui-pages/src/api";
import type { AuditEntry as LogEntry } from "../../agent/audit";
import { SIDEBAR_CLIENT } from "../../daemon/server";
import { AppError } from "../runs";
import * as v from "../validate";
import { capitalize, gone, notYet, plainly, type Methods } from "./common";
import type { PagesDeps } from "./deps";

const MODES: readonly PermissionMode[] = ["ask", "guard", "skip"];
const RULES = ["allow", "ask", "never"] as const;
const MAX_RULES = 1000;
const MAX_AUDIT = 500;

function outcome(e: LogEntry): AuditOutcome {
  if (e.result === "blocked") return "blocked";
  if (e.result === "declined" || e.approved === false) return "declined";
  return e.approved === true ? "approved" : "ran";
}

function clientLabel(client: string): string {
  if (client === SIDEBAR_CLIENT || client === "sidebar") return "Perch";
  if (client.startsWith("routine:")) return "Perch routine";
  return client;
}

function toEntry(line: string): AuditEntry | null {
  try {
    const e = JSON.parse(line) as LogEntry;
    if (typeof e.time !== "string" || typeof e.action !== "string") return null;
    const words = capitalize(e.action.replace(/_/g, " "));
    const action = e.detail ? `${words}: ${String(e.detail).slice(0, 200)}` : words;
    return {
      id: createHash("sha256").update(line).digest("hex").slice(0, 24),
      at: e.time, client: clientLabel(String(e.client ?? "")), tab: String(e.tab ?? ""), site: String(e.site ?? ""), action, outcome: outcome(e),
    };
  } catch {
    return null;
  }
}

export function permissionsPages(deps: PagesDeps): Methods<
  "getPermissions" | "setPermissionMode" | "addSiteRule" | "removeSiteRule" | "setClientMode" | "listAuditLog" | "exportAuditLog"
> {
  async function permissions(): Promise<Permissions> {
    const s = await deps.state.get();
    const clientRules = deps.clients.list()
      .filter((c) => !c.revoked)
      .map((c) => ({ id: c.name, client: c.name, mode: c.mode, ...(c.lastUsed ? { lastUsed: c.lastUsed } : {}) }));
    return { mode: s.mode, siteRules: s.siteRules, clientRules, maxMode: null };
  }

  async function auditLog(): Promise<AuditEntry[]> {
    const texts = await Promise.all(deps.auditFiles.map((f) => readFile(f, "utf8").catch(() => "")));
    return texts
      .flatMap((t) => t.split("\n").filter(Boolean).map(toEntry))
      .filter((e): e is AuditEntry => e !== null)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  return {
    getPermissions: () => permissions(),
    async setPermissionMode([mode]) {
      const clean = v.oneOf(mode, "mode", MODES);
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
      if (!deps.clients.list().some((c) => c.name === name && !c.revoked)) gone("That client is no longer connected to Perch");
      await plainly(() => deps.clients.setMode(name, clean));
      return permissions();
    },
    async listAuditLog([query]) {
      const o = v.object(query, '"query"');
      v.onlyKeys(o, ["limit", "before"]);
      const limit = v.integer(o.limit, "limit", 0, MAX_AUDIT);
      const before = v.optionalText(o.before, "before", 40);
      if (before !== undefined && Number.isNaN(Date.parse(before))) throw new AppError('"before" must be a date and time');
      const all = await auditLog();
      return (before ? all.filter((e) => e.at < before) : all).slice(0, limit);
    },
    async exportAuditLog() {
      return notYet("Perch can't export the audit log yet: it needs a save dialog, which this version doesn't have.");
    },
  };
}
