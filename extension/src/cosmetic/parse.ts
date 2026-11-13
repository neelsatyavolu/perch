/**
 * Parses element-hiding filters (`##`, `#@#`) and the network exceptions that switch element hiding
 * off for a site (`@@||site^$generichide`, `$elemhide`). Build time only: it uses node:url.
 */

import { domainToASCII } from "node:url";
import { checkSelector } from "./selector";

export type HideFilter = {
  readonly exception: boolean;
  /** Empty means every site. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly selector: string;
};

export type HideSwitch = { readonly kind: "generichide" | "elemhide"; readonly hosts: readonly string[] };

export type CosmeticParse = { filter: HideFilter } | { hideSwitch: HideSwitch } | { skip: string } | null;

/** Hosts that are safe in a content script match pattern as well as in a lookup. */
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

export function parseCosmetic(raw: string): CosmeticParse {
  const line = raw.trim();
  if (!line || line.startsWith("!") || line.startsWith("[")) return null;
  if (line.startsWith("@@")) return parseHideSwitch(line);

  const at = line.indexOf("#");
  if (at === -1) return null;
  const rest = line.slice(at);
  const exception = rest.startsWith("#@#");
  if (!exception && !rest.startsWith("##")) {
    // `#?#`, `#$#`, `#%#`, `#@?#`, `#@$#`: procedural filters, snippets and scripts.
    return /^#@?[?$%]{1,2}#/.test(rest) ? { skip: "procedural" } : null;
  }
  const selector = rest.slice(exception ? 3 : 2).trim();
  if (selector.startsWith("+js(")) return { skip: "scriptlet" };
  const domains = parseDomains(line.slice(0, at));
  if (!domains) return { skip: "unsupported-domain" };
  const problem = checkSelector(selector);
  if (problem) return { skip: problem };
  return { filter: { exception, ...domains, selector } };
}

/** `a.com,~b.a.com`; `*` and an empty list mean every site. Entity (`google.*`) and regex domains are dropped. */
function parseDomains(text: string): { include: string[]; exclude: string[] } | null {
  const include: string[] = [];
  const exclude: string[] = [];
  let droppedInclude = false;
  for (const entry of text.split(",")) {
    const negated = entry.trim().startsWith("~");
    const name = entry.trim().replace(/^~/, "").toLowerCase();
    if (!name || name === "*") continue;
    const ascii = name.includes("*") || name.includes("/") ? "" : domainToASCII(name);
    if (!ascii || !HOST.test(ascii)) {
      if (!negated) droppedInclude = true;
      continue;
    }
    (negated ? exclude : include).push(ascii);
  }
  if (droppedInclude && include.length === 0) return null;
  return { include: [...new Set(include)], exclude: [...new Set(exclude)] };
}

const SWITCHES: Readonly<Record<string, HideSwitch["kind"]>> = { generichide: "generichide", ghide: "generichide", elemhide: "elemhide", ehide: "elemhide" };

/** `@@||site^$generichide` and `@@$generichide,domain=a|b`. URL-specific forms are skipped. */
function parseHideSwitch(line: string): CosmeticParse {
  const dollar = line.lastIndexOf("$");
  if (dollar === -1) return null;
  const options = line.slice(dollar + 1).split(",").map((o) => o.trim().toLowerCase());
  const kinds = options.map((o) => SWITCHES[o]).filter((k): k is HideSwitch["kind"] => !!k);
  if (kinds.length === 0) return null;
  const kind = kinds.includes("elemhide") ? "elemhide" : "generichide";
  const others = options.filter((o) => !SWITCHES[o]);
  const pattern = line.slice(2, dollar);

  const host = /^\|\|([a-z0-9.-]+)\^?$/i.exec(pattern)?.[1]?.toLowerCase();
  if (host && others.length === 0 && HOST.test(host)) return { hideSwitch: { kind, hosts: [host] } };

  const domainOption = others.length === 1 ? /^(?:domain|from)=(.+)$/.exec(others[0]!)?.[1] : undefined;
  if ((pattern === "" || pattern === "*") && domainOption) {
    const domains = parseDomains(domainOption.replaceAll("|", ","));
    if (domains && domains.include.length && domains.exclude.length === 0) return { hideSwitch: { kind, hosts: domains.include } };
  }
  return { skip: `${kind}-url` };
}
