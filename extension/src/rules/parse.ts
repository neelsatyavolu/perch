/** Parses Adblock Plus network filters (the EasyList syntax) into a plain structure. */

import { domainToASCII } from "node:url";
import type { ResourceType } from "./limits";

export type Filter = {
  readonly exception: boolean;
  /** The URL pattern with `@@` and options removed; empty means "any URL". */
  readonly pattern: string;
  readonly types: readonly ResourceType[];
  readonly excludedTypes: readonly ResourceType[];
  readonly party?: "first" | "third";
  readonly initiatorDomains: readonly string[];
  readonly excludedInitiatorDomains: readonly string[];
  readonly matchCase: boolean;
  readonly important: boolean;
  /** `$document`: on an exception, allow the whole page; on a block, block the page itself. */
  readonly document: boolean;
};

export type ParseResult = { filter: Filter } | { skip: string } | null;

const TYPE_OPTIONS: Readonly<Record<string, ResourceType>> = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  object: "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  frame: "sub_frame",
  ping: "ping",
  beacon: "ping",
  media: "media",
  font: "font",
  websocket: "websocket",
  other: "other",
};

/** Cosmetic and scriptlet separators: `##`, `#@#`, `#?#`, `#$#`, `#%#`, `#@?#` and so on. */
const COSMETIC = /#[@?$%]*#|#@[$?]#/;

export function parseFilter(raw: string): ParseResult {
  const line = raw.trim();
  if (!line || line.startsWith("!") || line.startsWith("[")) return null;
  if (COSMETIC.test(line)) return { skip: "cosmetic" };

  const exception = line.startsWith("@@");
  const body = exception ? line.slice(2) : line;
  const dollar = findOptionsStart(body);
  const pattern = dollar === -1 ? body : body.slice(0, dollar);
  const optionText = dollar === -1 ? "" : body.slice(dollar + 1);

  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) return { skip: "regex" };
  if (!isAscii(pattern)) return { skip: "non-ascii" };

  const options = parseOptions(optionText);
  if ("skip" in options) return options;
  const filter: Filter = { exception, pattern: pattern === "*" ? "" : pattern, ...options };
  if (!filter.pattern && filter.initiatorDomains.length === 0 && filter.types.length === 0 && !filter.document) return { skip: "too-broad" };
  return { filter };
}

/** The `$` that starts options: the last one, unless it is part of the URL (no option follows). */
function findOptionsStart(body: string): number {
  const at = body.lastIndexOf("$");
  if (at === -1) return -1;
  const rest = body.slice(at + 1);
  return /^~?[a-z0-9_-]+(=|,|$)/i.test(rest) ? at : -1;
}

type Options = Omit<Filter, "exception" | "pattern">;

function parseOptions(text: string): Options | { skip: string } {
  const types: ResourceType[] = [];
  const excludedTypes: ResourceType[] = [];
  let party: "first" | "third" | undefined;
  let domains: { include: string[]; exclude: string[] } = { include: [], exclude: [] };
  let matchCase = false;
  let important = false;
  let document = false;

  for (const part of text ? text.split(",") : []) {
    const [rawName = "", value] = splitOnce(part.trim(), "=");
    const negated = rawName.startsWith("~");
    const name = (negated ? rawName.slice(1) : rawName).toLowerCase();
    const type = TYPE_OPTIONS[name];
    if (type) {
      (negated ? excludedTypes : types).push(type);
      continue;
    }
    switch (name) {
      case "third-party":
      case "3p":
        party = negated ? "first" : "third";
        break;
      case "first-party":
      case "1p":
        party = negated ? "third" : "first";
        break;
      case "domain":
      case "from": {
        if (value === undefined) return { skip: `option:${name}` };
        const parsed = parseDomains(value);
        if (!parsed) return { skip: "entity-domain" };
        domains = parsed;
        break;
      }
      case "match-case":
        matchCase = true;
        break;
      case "important":
        important = true;
        break;
      case "document":
      case "doc":
        if (negated) return { skip: `option:~${name}` };
        document = true;
        break;
      case "all":
        types.push("main_frame", ...Object.values(TYPE_OPTIONS).filter((t, i, a) => a.indexOf(t) === i));
        break;
      default:
        return { skip: `option:${name}` };
    }
  }
  return {
    types: unique(types),
    excludedTypes: unique(excludedTypes),
    ...(party ? { party } : {}),
    initiatorDomains: domains.include,
    excludedInitiatorDomains: domains.exclude,
    matchCase,
    important,
    document,
  };
}

/** `a.com|~b.a.com`. Entity domains (`google.*`) cannot be expressed in DNR and are dropped. */
function parseDomains(value: string): { include: string[]; exclude: string[] } | null {
  const include: string[] = [];
  const exclude: string[] = [];
  let droppedInclude = false;
  for (const entry of value.split("|")) {
    const negated = entry.startsWith("~");
    const name = (negated ? entry.slice(1) : entry).trim().toLowerCase();
    if (!name) continue;
    const ascii = name.endsWith(".*") || name.includes("*") ? "" : domainToASCII(name);
    if (!ascii) {
      if (!negated) droppedInclude = true;
      continue;
    }
    (negated ? exclude : include).push(ascii);
  }
  if (droppedInclude && include.length === 0) return null;
  return { include: unique(include), exclude: unique(exclude) };
}

function splitOnce(text: string, sep: string): [string, string | undefined] {
  const at = text.indexOf(sep);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function isAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}
