/**
 * Moving a server's secrets into the Keychain when it is saved, and putting them back together
 * when it launches. Every env and header value is treated as a secret, as are command arguments
 * that follow or carry a secret-looking flag (--token x, --api-key=x), credential headers passed as
 * arguments (--header "Authorization: ..."), and secret-looking NAME=value pairs (docker -e).
 */

import type { SecretStore } from "../secure/keychain";
import type { ServerConfig, Value } from "./types";

export type ResolvedConfig =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { transport: "http" | "sse"; url: string; headers: Record<string, string> };

const SECRET_FLAG = /^--?([a-z0-9]+[-_])*(token|api[-_]?key|apikey|key|secret|password|passwd|pat|auth|authorization|bearer|credentials?|client[-_]secret|access[-_]token)$/i;
const SECRET_FLAG_WITH_VALUE = /^(--?([a-z0-9]+[-_])*(token|api[-_]?key|apikey|key|secret|password|passwd|pat|auth|authorization|bearer|credentials?|client[-_]secret|access[-_]token))=./i;
const HEADER_FLAG = /^(--header|-H)$/;
const HEADER_FLAG_WITH_VALUE = /^--header=./;
const ENV_FLAG = /^(--env|-e)$/;
const ENV_FLAG_WITH_VALUE = /^--env=./;
/** A header that carries a credential. */
const SECRET_HEADER = /^\s*(authorization|proxy-authorization|cookie|[a-z0-9-]*(token|api-?key|secret|auth)[a-z0-9-]*)\s*:/i;
/** An environment variable name that suggests a credential. */
const SECRET_ENV_NAME = /(token|key|secret|password|passwd|pat|auth|credential|cookie|session)/i;
/** A value that only names a variable, like ${GITHUB_TOKEN} or $GITHUB_TOKEN. */
const PURE_VAR = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function account(server: string, kind: "env" | "header" | "arg", key: string | number): string {
  return `mcp/${server}/${kind}/${key}`;
}

/** NAME=value with a credential-like name and a value that is not just a variable. */
function secretPair(pair: string): boolean {
  const eq = pair.indexOf("=");
  if (eq <= 0) return false;
  const value = pair.slice(eq + 1);
  return SECRET_ENV_NAME.test(pair.slice(0, eq)) && value !== "" && !PURE_VAR.test(value);
}

/** Indexes of arguments that hold a secret. */
export function secretArgIndexes(args: readonly Value[]): number[] {
  const out: number[] = [];
  args.forEach((a, i) => {
    if (typeof a !== "string") return;
    if (SECRET_FLAG_WITH_VALUE.test(a)) out.push(i);
    const prev = args[i - 1];
    const after = (flag: RegExp) => typeof prev === "string" && flag.test(prev);
    if (after(SECRET_FLAG) && !a.startsWith("-")) out.push(i);
    else if (HEADER_FLAG_WITH_VALUE.test(a) ? SECRET_HEADER.test(a.slice(a.indexOf("=") + 1)) : after(HEADER_FLAG) && SECRET_HEADER.test(a)) out.push(i);
    else if (ENV_FLAG_WITH_VALUE.test(a) ? secretPair(a.slice(a.indexOf("=") + 1)) : after(ENV_FLAG) && secretPair(a)) out.push(i);
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

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Every variable a value reads at launch: ${VAR} anywhere in it, or a value that is just $VAR. */
export function varsIn(text: string): string[] {
  const pure = text.match(PURE_VAR);
  if (pure) return [(pure[1] ?? pure[2])!];
  return [...new Set([...text.matchAll(VAR_REF)].map((m) => m[1]!))];
}

/** Expands ${VAR} and ${VAR:-default}, the forms Claude Code supports. */
export function expandVars(text: string, env: Record<string, string | undefined>): string {
  return text.replace(VAR_REF, (_, name: string, fallback?: string) => env[name] ?? fallback ?? "");
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
