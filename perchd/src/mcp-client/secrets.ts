/**
 * Moving a server's secrets into the Keychain when it is saved, and putting them back together
 * when it launches. Every env and header value is treated as a secret, as are command arguments
 * that follow or carry a secret-looking flag (--token x, --api-key=x).
 */

import { createHash } from "node:crypto";
import type { SecretStore } from "../secure/keychain";
import type { ServerConfig, Value } from "./types";

export type ResolvedConfig =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { transport: "http" | "sse"; url: string; headers: Record<string, string> };

const SECRET_FLAG = /^--?([a-z0-9]+[-_])*(token|api[-_]?key|apikey|key|secret|password|passwd|pat|auth|authorization|bearer|credentials?|client[-_]secret|access[-_]token)$/i;
const SECRET_FLAG_WITH_VALUE = /^(--?([a-z0-9]+[-_])*(token|api[-_]?key|apikey|key|secret|password|passwd|pat|auth|authorization|bearer|credentials?|client[-_]secret|access[-_]token))=./i;
/** A value that only names a variable, like ${GITHUB_TOKEN} or $GITHUB_TOKEN. */
const PURE_VAR = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function account(server: string, kind: "env" | "header" | "arg", key: string | number): string {
  return `mcp/${server}/${kind}/${key}`;
}

/** Indexes of arguments that hold a secret. */
export function secretArgIndexes(args: readonly Value[]): number[] {
  const out: number[] = [];
  args.forEach((a, i) => {
    if (typeof a !== "string") return;
    if (SECRET_FLAG_WITH_VALUE.test(a)) out.push(i);
    const prev = args[i - 1];
    if (typeof prev === "string" && SECRET_FLAG.test(prev) && !a.startsWith("-")) out.push(i);
  });
  return out;
}

function pureVar(v: string): Value | null {
  const m = v.match(PURE_VAR);
  return m ? { env: (m[1] ?? m[2])! } : null;
}

async function toSecret(kc: SecretStore, acct: string, v: Value): Promise<Value> {
  if (typeof v !== "string") return v;
  const ref = pureVar(v);
  if (ref) return ref;
  await kc.set(acct, v);
  return { secret: acct };
}

async function mapSecrets(kc: SecretStore, map: Record<string, Value>, acct: (k: string) => string): Promise<Record<string, Value>> {
  const entries = await Promise.all(Object.entries(map).map(async ([k, v]) => [k, await toSecret(kc, acct(k), v)] as const));
  return Object.fromEntries(entries);
}

/** Writes the config's secret values to the Keychain and returns the config with references. */
export async function storeSecrets(server: string, config: ServerConfig, kc: SecretStore): Promise<ServerConfig> {
  if (config.transport !== "stdio") {
    return { ...config, headers: await mapSecrets(kc, config.headers, (k) => account(server, "header", k)) };
  }
  const secretArgs = new Set(secretArgIndexes(config.args));
  const args = await Promise.all(config.args.map((a, i) => (secretArgs.has(i) ? toSecret(kc, account(server, "arg", i), a) : a)));
  return { ...config, args, env: await mapSecrets(kc, config.env, (k) => account(server, "env", k)) };
}

/** Every Keychain account a config refers to, so removing a server can delete them. */
export function secretAccounts(config: ServerConfig): string[] {
  const values: Value[] = config.transport === "stdio" ? [...config.args, ...Object.values(config.env)] : Object.values(config.headers);
  return values.flatMap((v) => (typeof v === "object" && "secret" in v ? [v.secret] : []));
}

/** Expands ${VAR} and ${VAR:-default}, the forms Claude Code supports. */
export function expandVars(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? "");
}

async function resolveValue(v: Value, kc: SecretStore, env: Record<string, string | undefined>, label: string): Promise<string> {
  if (typeof v === "string") return expandVars(v, env);
  if ("env" in v) return env[v.env] ?? "";
  const value = await kc.get(v.secret);
  if (value === null) throw new Error(`The Keychain item for ${label} is missing. Edit the server and enter it again.`);
  return expandVars(value, env);
}

export async function resolveConfig(config: ServerConfig, kc: SecretStore, env: Record<string, string | undefined>, server = config.transport === "stdio" ? config.command : config.url): Promise<ResolvedConfig> {
  const map = async (m: Record<string, Value>) =>
    Object.fromEntries(await Promise.all(Object.entries(m).map(async ([k, v]) => [k, await resolveValue(v, kc, env, `${k} of "${server}"`)] as const)));
  if (config.transport !== "stdio") return { transport: config.transport, url: expandVars(config.url, env), headers: await map(config.headers) };
  const args = await Promise.all(config.args.map((a, i) => resolveValue(a, kc, env, `argument ${i + 1} of "${server}"`)));
  return { transport: "stdio", command: expandVars(config.command, env), args, env: await map(config.env), ...(config.cwd ? { cwd: expandVars(config.cwd, env) } : {}) };
}

/** What the user approves before a stdio server first runs: the command and its arguments. */
export function launchFingerprint(config: ServerConfig): string {
  const what = config.transport === "stdio" ? [config.command, ...config.args.map((a) => JSON.stringify(a)), config.cwd ?? ""] : [config.url];
  return createHash("sha256").update(JSON.stringify(what)).digest("hex").slice(0, 32);
}
