/**
 * The element-hiding data the service worker reads (dist/cosmetic/sites.json) and the pure lookup
 * that turns it into the stylesheet for one frame. No Node or Chrome APIs: runs anywhere.
 */

import { hideCss } from "./selector";

export type CosmeticData = {
  /** Every selector the data refers to; the maps below hold indexes into it. */
  readonly selectors: readonly string[];
  /** Generic selectors some site excepts, so they cannot go in the static generic.css. */
  readonly generic: readonly number[];
  /** Site-specific hides by host; a host's entry also covers its subdomains. */
  readonly hide: Readonly<Record<string, readonly number[]>>;
  /** `#@#` exceptions and `~site` exclusions by host. */
  readonly unhide: Readonly<Record<string, readonly number[]>>;
  /** `$generichide`: no generic hiding on these sites (and subdomains). */
  readonly genericHide: readonly string[];
  /** `$elemhide`: no element hiding at all on these sites. */
  readonly elemHide: readonly string[];
};

export const EMPTY_COSMETIC: CosmeticData = { selectors: [], generic: [], hide: {}, unhide: {}, genericHide: [], elemHide: [] };

/** The host and each parent domain: a.b.example.com, b.example.com, example.com, com. IPs only match exactly. */
export function hostChain(host: string): string[] {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h) return [];
  if (/^\d+(\.\d+){3}$/.test(h) || h.includes(":") || h.startsWith("[")) return [h];
  const labels = h.split(".");
  return labels.map((_, i) => labels.slice(i).join("."));
}

/** True when the host or a parent domain is in the list. */
export function coveredBy(list: readonly string[], host: string): boolean {
  const chain = new Set(hostChain(host));
  return list.some((entry) => chain.has(entry));
}

/** The selectors to hide in a frame at `host`, beyond the static generic.css. */
export function siteSelectors(data: CosmeticData, host: string): string[] {
  const chain = hostChain(host);
  if (chain.length === 0 || coveredBy(data.elemHide, host)) return [];
  const unhide = new Set(chain.flatMap((h) => data.unhide[h] ?? []));
  const hide = new Set(chain.flatMap((h) => data.hide[h] ?? []));
  if (!coveredBy(data.genericHide, host)) for (const i of data.generic) hide.add(i);
  return [...hide].filter((i) => !unhide.has(i)).sort((a, b) => a - b).map((i) => data.selectors[i]!).filter(Boolean);
}

/** The stylesheet to insert in a frame at `host`, or "" when there is nothing to hide. */
export function siteCss(data: CosmeticData, host: string): string {
  return hideCss(siteSelectors(data, host));
}

/** Hosts the static generic.css must not run on. */
export function genericExemptHosts(data: CosmeticData): string[] {
  return [...new Set([...data.genericHide, ...data.elemHide])].sort();
}

/** Accepts anything parsed from sites.json and returns usable data, or the empty set when the shape is wrong. */
export function sanitizeCosmetic(raw: unknown): CosmeticData {
  if (typeof raw !== "object" || raw === null) return EMPTY_COSMETIC;
  const v = raw as Record<string, unknown>;
  const strings = (x: unknown) => (Array.isArray(x) && x.every((s) => typeof s === "string") ? (x as string[]) : null);
  const numbers = (x: unknown) => (Array.isArray(x) && x.every((n) => Number.isInteger(n)) ? (x as number[]) : null);
  const map = (x: unknown) =>
    typeof x === "object" && x !== null && Object.values(x).every((e) => numbers(e)) ? (x as Record<string, number[]>) : null;
  const selectors = strings(v.selectors);
  const generic = numbers(v.generic);
  const hide = map(v.hide);
  const unhide = map(v.unhide);
  const genericHide = strings(v.genericHide);
  const elemHide = strings(v.elemHide);
  if (!selectors || !generic || !hide || !unhide || !genericHide || !elemHide) return EMPTY_COSMETIC;
  return { selectors, generic, hide, unhide, genericHide, elemHide };
}
