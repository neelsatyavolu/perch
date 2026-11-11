/** Input checks at the API boundary. Each returns the clean value or throws an AppError (400). */

import { ARTIFACT_KINDS } from "./artifacts";
import type { ArtifactKind, ChatSettings, Effort, Mode, Scope, TabInfo, TabRef } from "./protocol";
import { AppError } from "./runs";

type Obj = Record<string, unknown>;

export function object(value: unknown, what = "the request body"): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(`${what} must be a JSON object`);
  return value as Obj;
}

export function onlyKeys(body: Obj, keys: string[]): void {
  const extra = Object.keys(body).find((k) => !keys.includes(k));
  if (extra) throw new AppError(`unexpected field "${extra}"`);
}

export function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new AppError(`"${name}" must be text`);
  if (value.length > max) throw new AppError(`"${name}" is too long (${max.toLocaleString("en-US")} characters at most)`);
  return value;
}

export function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, name, max);
}

export function id(value: unknown, name: string): string {
  const s = text(value, name, 128);
  if (!/^[\w.:-]{1,128}$/.test(s)) throw new AppError(`"${name}" is not a valid id`);
  return s;
}

export function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e8) throw new AppError(`"${name}" must be a number of 0 or more`);
  return value;
}

export function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new AppError(`"${name}" must be true or false`);
  return value;
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new AppError(`"${name}" must be one of ${allowed.join(", ")}`);
  return value as T;
}

export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new AppError(`"${name}" must be a whole number from ${min} to ${max}`);
  return value;
}

export function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new AppError(`"${name}" must be a list`);
  if (value.length > max) throw new AppError(`"${name}" has too many items (${max.toLocaleString("en-US")} at most)`);
  return value;
}

/** A method's arguments as the pages send them: a JSON array of at most `max` items. */
export function args(value: unknown, max: number): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError("The arguments must be a JSON array");
  if (value.length > max) throw new AppError(max === 0 ? "This method takes no arguments" : `This method takes at most ${max} argument${max === 1 ? "" : "s"}`);
  return value;
}

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;

/**
 * A site rule's pattern in Lulltab's forms: `github.com` (and subdomains), `=host` (exact),
 * `*.host` (subdomains only), `host/path` (path and below) and full URL prefixes.
 */
export function sitePattern(value: unknown): string {
  const raw = text(value, "pattern", 500).trim();
  if (!raw) throw new AppError("Enter a site, like github.com");
  if (/\s/.test(raw)) throw new AppError("A site can't contain spaces");
  if (/^https?:\/\//i.test(raw)) {
    if (!URL.canParse(raw)) throw new AppError("That link isn't a valid web address");
    return raw;
  }
  const exact = raw.startsWith("=");
  const rest = exact ? raw.slice(1) : raw;
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  if (!HOST.test(host) || (exact && host.startsWith("*."))) throw new AppError("Enter a site, like github.com or *.example.com");
  return `${exact ? "=" : ""}${host}${slash === -1 ? "" : rest.slice(slash)}`;
}

export function tabRef(value: unknown, name = "tab"): TabRef {
  const o = object(value, `"${name}"`);
  return { id: id(o.id, `${name}.id`), windowId: id(o.windowId, `${name}.windowId`) };
}

export function tabInfo(value: unknown, name = "tab"): TabInfo {
  const o = object(value, `"${name}"`);
  return {
    ...tabRef(o, name),
    title: text(o.title ?? "", `${name}.title`, 1000),
    url: text(o.url ?? "", `${name}.url`, 8000),
    ...(o.targetId === undefined ? {} : { targetId: id(o.targetId, `${name}.targetId`) }),
    ...(o.incognito === true ? { incognito: true } : {}),
    ...(typeof o.favicon === "string" && FAVICON.test(o.favicon) && o.favicon.length <= 24_000 ? { favicon: o.favicon } : {}),
  };
}

/** Only a base64 PNG data URL is kept as a tab's icon; anything else is dropped. */
const FAVICON = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export function settingsPatch(value: unknown, models: string[]): Partial<ChatSettings> {
  const o = object(value, '"settings"');
  onlyKeys(o, ["mode", "model", "effort", "scope"]);
  const out: Partial<ChatSettings> = {};
  if (o.mode !== undefined) out.mode = oneOf<Mode>(o.mode, "mode", ["ask", "guard", "skip"]);
  if (o.effort !== undefined) out.effort = oneOf<Effort>(o.effort, "effort", ["low", "medium", "high"]);
  if (o.scope !== undefined) out.scope = oneOf<Scope>(o.scope, "scope", ["current", "all", "agent"]);
  if (o.model !== undefined) out.model = oneOf(o.model, "model", models);
  return out;
}

export function artifactKind(value: unknown): ArtifactKind {
  return oneOf(value, "kind", ARTIFACT_KINDS);
}
