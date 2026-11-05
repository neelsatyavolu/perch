/** Turns parsed filters into declarativeNetRequest rules, merges host filters and keeps to the rule budget. */

import { parseFilter, type Filter } from "./parse";
import { ALL_RESOURCE_TYPES, PRIORITY, STATIC_RULE_BUDGET, type ResourceType } from "./limits";

export type Condition = {
  urlFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  requestDomains?: string[];
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  resourceTypes?: ResourceType[];
  excludedResourceTypes?: ResourceType[];
  domainType?: "firstParty" | "thirdParty";
  regexFilter?: string;
};

export type Action =
  | { type: "block" | "allow" | "allowAllRequests" }
  | { type: "redirect"; redirect: { transform: { queryTransform: { removeParams: string[] } } } };

export type RuleBody = { priority: number; action: Action; condition: Condition };
export type Rule = RuleBody & { id: number };

export type ListStats = { filters: number; rules: number; skipped: Record<string, number> };
export type CompiledLists = { rulesets: { id: string; rules: Rule[] }[]; stats: Record<string, ListStats> };

export function toRule(filter: Filter): RuleBody {
  const condition: Condition = {};
  const pattern = filter.pattern.startsWith("||*") ? filter.pattern.slice(2) : filter.pattern;
  if (pattern) condition.urlFilter = pattern;
  if (filter.matchCase) condition.isUrlFilterCaseSensitive = true;
  if (filter.initiatorDomains.length) condition.initiatorDomains = [...filter.initiatorDomains];
  if (filter.excludedInitiatorDomains.length) condition.excludedInitiatorDomains = [...filter.excludedInitiatorDomains];

  if (filter.document && filter.exception) {
    condition.resourceTypes = ["main_frame", "sub_frame"];
  } else if (filter.document) {
    condition.resourceTypes = unique(["main_frame", ...filter.types]);
  } else if (filter.types.length) {
    condition.resourceTypes = [...filter.types];
  } else if (filter.excludedTypes.length) {
    // With only exclusions DNR would also match page loads, which Adblock Plus never blocks.
    condition.excludedResourceTypes = unique([...filter.excludedTypes, "main_frame"]);
  }
  if (filter.party) condition.domainType = filter.party === "third" ? "thirdParty" : "firstParty";

  const type = filter.exception ? (filter.document ? "allowAllRequests" : "allow") : "block";
  const priority = filter.exception
    ? filter.important
      ? PRIORITY.importantAllow
      : PRIORITY.allow
    : filter.important
      ? PRIORITY.important
      : PRIORITY.block;
  return { priority, action: { type }, condition };
}

/** Returns why Chrome would reject a rule, or null. Run on every compiled rule at build time. */
export function validateRule(rule: Rule): string | null {
  if (!Number.isInteger(rule.id) || rule.id < 1) return "id must be a positive integer";
  if (!Number.isInteger(rule.priority) || rule.priority < 1) return "priority must be a positive integer";
  const c = rule.condition;
  if (c.urlFilter !== undefined) {
    if (!c.urlFilter) return "urlFilter is empty";
    if (c.urlFilter.startsWith("||*")) return "urlFilter may not start with ||*";
    if (!/^[\x20-\x7e]+$/.test(c.urlFilter)) return "urlFilter must be ASCII";
  }
  if (c.urlFilter !== undefined && c.regexFilter !== undefined) return "urlFilter and regexFilter are exclusive";
  for (const key of ["requestDomains", "initiatorDomains", "resourceTypes"] as const) {
    const list = c[key];
    if (list && list.length === 0) return `${key} is empty`;
  }
  for (const key of ["requestDomains", "initiatorDomains", "excludedInitiatorDomains"] as const) {
    for (const domain of c[key] ?? []) if (!/^[a-z0-9.-]+$/.test(domain)) return `${key} has a non-canonical domain: ${domain}`;
  }
  for (const t of [...(c.resourceTypes ?? []), ...(c.excludedResourceTypes ?? [])]) {
    if (!ALL_RESOURCE_TYPES.includes(t)) return `unknown resource type ${t}`;
  }
  if (rule.action.type === "allowAllRequests" && c.resourceTypes?.some((t) => t !== "main_frame" && t !== "sub_frame")) {
    return "allowAllRequests only applies to frames";
  }
  return null;
}

/** Compiles lists in order; once the budget is used up, the rest are counted as skipped. */
export function compileLists(lists: readonly { id: string; text: string }[], budget = STATIC_RULE_BUDGET): CompiledLists {
  let left = budget;
  const rulesets: CompiledLists["rulesets"] = [];
  const stats: CompiledLists["stats"] = {};
  for (const list of lists) {
    const { bodies, stat } = compileList(list.text);
    const kept = bodies.slice(0, Math.max(0, left));
    const dropped = bodies.length - kept.length;
    if (dropped) stat.skipped.budget = dropped;
    left -= kept.length;
    const rules = kept.map((body, i) => ({ id: i + 1, ...body }));
    for (const rule of rules) {
      const problem = validateRule(rule);
      if (problem) throw new Error(`${list.id} rule ${rule.id}: ${problem}`);
    }
    rulesets.push({ id: list.id, rules });
    stats[list.id] = { ...stat, rules: rules.length };
  }
  return { rulesets, stats };
}

function compileList(text: string): { bodies: RuleBody[]; stat: ListStats } {
  const skipped: Record<string, number> = {};
  let filters = 0;
  const bodies: RuleBody[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseFilter(line);
    if (!parsed) continue;
    filters++;
    if ("skip" in parsed) {
      skipped[parsed.skip] = (skipped[parsed.skip] ?? 0) + 1;
      continue;
    }
    bodies.push(toRule(parsed.filter));
  }
  const merged = mergeHostRules(bodies);
  return { bodies: merged, stat: { filters, rules: merged.length, skipped } };
}

const HOST_ONLY = /^\|\|([a-z0-9.-]+)\^$/i;

/** `||a.com^` and `||b.com^` with identical everything else become one rule with requestDomains. */
function mergeHostRules(bodies: readonly RuleBody[]): RuleBody[] {
  const groups = new Map<string, { body: RuleBody; hosts: Set<string> }>();
  const seen = new Set<string>();
  const out: (RuleBody | string)[] = [];
  for (const body of bodies) {
    const host = body.condition.isUrlFilterCaseSensitive ? undefined : HOST_ONLY.exec(body.condition.urlFilter ?? "")?.[1];
    if (!host) {
      const key = JSON.stringify(body);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(body);
      continue;
    }
    const { urlFilter: _drop, ...rest } = body.condition;
    const key = JSON.stringify({ ...body, condition: rest });
    const group = groups.get(key);
    if (group) group.hosts.add(host.toLowerCase());
    else {
      groups.set(key, { body: { ...body, condition: rest }, hosts: new Set([host.toLowerCase()]) });
      out.push(key);
    }
  }
  return out.map((entry) => {
    if (typeof entry !== "string") return entry;
    const { body, hosts } = groups.get(entry)!;
    if (hosts.size === 1) return { ...body, condition: { urlFilter: `||${[...hosts][0]}^`, ...body.condition } };
    return { ...body, condition: { requestDomains: [...hosts].sort(), ...body.condition } };
  });
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
