/**
 * What the user approves before Perch first runs a local server or connects to a remote one, and
 * the fingerprint that makes Perch ask again when any of it changes. Secret values are never
 * shown: they appear as ••••, and only the names of environment variables are listed.
 */

import { createHash } from "node:crypto";
import type { SecretStore } from "../secure/keychain";
import { maskUrl } from "./importers/preview";
import { secretArgIndexes, varsIn } from "./secrets";
import type { ServerConfig, ServerEntry, Value } from "./types";

export type LaunchRequest =
  | { server: string; transport: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, string>; fromEnv: string[]; warnings: string[] }
  | { server: string; transport: "http" | "sse"; url: string; headers: string[]; fromEnv: string[]; warnings: string[] };

const MASK = "••••";
/** Variables that make a program load extra code at start-up. */
const LOADER_VAR = /^(NODE_OPTIONS|NODE_PATH|DYLD_\w+|LD_\w+|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONINSPECT|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/;

const sorted = (m: Record<string, Value>) => Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Covers everything that decides what runs or where requests go: command, args, cwd and env, or URL and headers. */
export function launchFingerprint(config: ServerConfig): string {
  const what = config.transport === "stdio" ? [config.command, config.args, config.cwd ?? "", sorted(config.env)] : [config.transport, config.url, sorted(config.headers)];
  return createHash("sha256").update(JSON.stringify(what)).digest("hex").slice(0, 32);
}

/** Variable names a value reads from Perch's environment, looking inside Keychain values too. */
async function readsFrom(v: Value, keychain: SecretStore): Promise<string[]> {
  if (typeof v === "string") return varsIn(v);
  if ("env" in v) return [v.env];
  return varsIn((await keychain.get(v.secret).catch(() => null)) ?? "");
}

async function allVars(values: Value[], keychain: SecretStore): Promise<string[]> {
  return [...new Set((await Promise.all(values.map((v) => readsFrom(v, keychain)))).flat())];
}

const shown = (v: Value): string => (typeof v === "string" ? v : "env" in v ? `$${v.env}` : MASK);

export async function launchRequest(entry: ServerEntry, keychain: SecretStore): Promise<LaunchRequest> {
  const c = entry.config;
  if (c.transport !== "stdio") {
    const fromEnv = await allVars([c.url, ...Object.values(c.headers)], keychain);
    const warnings = fromEnv.length ? [`Perch would send values from its environment to this server: ${fromEnv.join(", ")}.`] : [];
    return { server: entry.name, transport: c.transport, url: maskUrl(c.url).url, headers: Object.keys(c.headers), fromEnv, warnings };
  }
  const hidden = new Set(secretArgIndexes(c.args));
  const args = c.args.map((a, i) => (hidden.has(i) ? MASK : shown(a)));
  // Every env value is stored in the Keychain unless it only names a variable, so plain values here were typed by the user.
  const env = Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, shown(v)]));
  const fromEnv = await allVars([c.command, ...c.args.filter((_, i) => !hidden.has(i)), ...Object.values(c.env), ...(c.cwd ? [c.cwd] : [])], keychain);
  const warnings = Object.keys(c.env).filter((k) => LOADER_VAR.test(k)).map((k) => `${k} changes what the program loads when it starts.`);
  return { server: entry.name, transport: "stdio", command: c.command, args, ...(c.cwd ? { cwd: c.cwd } : {}), env, fromEnv, warnings };
}

/** One line for a terminal prompt. */
export function describeLaunch(r: LaunchRequest): string {
  const notes = [...(r.fromEnv.length ? [`reads ${r.fromEnv.join(", ")} from the environment`] : []), ...r.warnings];
  if (r.transport !== "stdio") return `Connect ${r.server} to ${r.url}${r.headers.length ? ` with headers ${r.headers.join(", ")}` : ""}?${notes.length ? ` (${notes.join("; ")})` : ""}`;
  const env = Object.entries(r.env).map(([k, v]) => `${k}=${v}`);
  return `Run ${[...env, r.command, ...r.args].join(" ")}${r.cwd ? ` in ${r.cwd}` : ""} for ${r.server}?${notes.length ? ` (${notes.join("; ")})` : ""}`;
}
