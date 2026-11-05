/**
 * MCP server entries as Perch stores them. A value is plain text, a reference to a Keychain item
 * ({ secret }), or a variable read from Perch's environment at launch ({ env }). Secret values
 * themselves never appear in an entry.
 */

export type Value = string | { secret: string } | { env: string };

export type StdioConfig = { transport: "stdio"; command: string; args: Value[]; env: Record<string, Value>; cwd?: string };
/** An app registered with the server's sign-in provider, for servers that do not allow automatic registration. */
export type OAuthClientConfig = { clientId: string; callbackPort?: number };
/** "http" is Streamable HTTP and falls back to the older SSE transport; "sse" is SSE only. */
export type HttpConfig = { transport: "http" | "sse"; url: string; headers: Record<string, Value>; oauth?: OAuthClientConfig };
export type ServerConfig = StdioConfig | HttpConfig;

export type ServerEntry = {
  name: string;
  config: ServerConfig;
  enabled: boolean;
  /** Trusted servers' tools count as ordinary changes instead of risky actions (spec 7.5). */
  trusted: boolean;
  /** Where it was imported from, such as "Claude Code (user)". */
  source?: string;
  /** Fingerprint of what the user approved (command and env, or URL and headers); Perch asks again when it changes. */
  approvedLaunch?: string;
  addedAt: string;
};

export const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/** A name that fits the agent's tool names: letters, digits, _ and -, at most 32 characters. */
export function sanitizeName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return clean || "server";
}

function fail(message: string): never {
  throw new Error(message);
}

function parseValue(v: unknown, where: string): Value {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.secret === "string" && Object.keys(o).length === 1) return { secret: o.secret };
    if (typeof o.env === "string" && ENV_NAME.test(o.env) && Object.keys(o).length === 1) return { env: o.env };
  }
  return fail(`${where} must be text, { secret } or { env }`);
}

function parseMap(raw: unknown, where: string, keyPattern: RegExp): Record<string, Value> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${where} must be an object`);
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([k, v]) => {
      if (!keyPattern.test(k)) fail(`${where} has an invalid name "${k.slice(0, 40)}"`);
      return [k, parseValue(v, `${where}.${k}`)];
    }),
  );
}

const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;

function parseOAuth(raw: unknown): OAuthClientConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof o.clientId !== "string" || !CLIENT_ID.test(o.clientId)) fail("oauth.clientId must be 1-256 visible characters");
  const port = o.callbackPort;
  if (port !== undefined && !(Number.isInteger(port) && (port as number) >= 1024 && (port as number) <= 65535)) fail("oauth.callbackPort must be a port from 1024 to 65535");
  return { clientId: o.clientId, ...(port === undefined ? {} : { callbackPort: port as number }) };
}

export function parseConfig(raw: unknown): ServerConfig {
  if (!raw || typeof raw !== "object") fail("server config must be an object");
  const c = raw as Record<string, unknown>;
  if (c.transport === "stdio") {
    if (typeof c.command !== "string" || !c.command.trim()) fail("a stdio server needs a command");
    if (c.args !== undefined && !Array.isArray(c.args)) fail("args must be a list");
    if (c.cwd !== undefined && typeof c.cwd !== "string") fail("cwd must be text");
    return {
      transport: "stdio",
      command: c.command,
      args: ((c.args as unknown[]) ?? []).map((a, i) => parseValue(a, `args[${i}]`)),
      env: parseMap(c.env, "env", ENV_NAME),
      ...(c.cwd ? { cwd: c.cwd as string } : {}),
    };
  }
  if (c.transport === "http" || c.transport === "sse") {
    if (typeof c.url !== "string") fail("an HTTP server needs a url");
    let url: URL;
    try {
      url = new URL(c.url);
    } catch {
      return fail(`"${c.url.slice(0, 80)}" is not a valid URL`);
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) fail("remote MCP servers must use https (plain http only for localhost)");
    return { transport: c.transport, url: url.toString(), headers: parseMap(c.headers, "headers", HEADER_NAME), ...(c.oauth === undefined ? {} : { oauth: parseOAuth(c.oauth) }) };
  }
  return fail('transport must be "stdio", "http" or "sse"');
}

export function parseEntry(raw: unknown): ServerEntry {
  if (!raw || typeof raw !== "object") fail("server entry must be an object");
  const e = raw as Record<string, unknown>;
  if (typeof e.name !== "string" || !NAME.test(e.name)) fail(`server name "${String(e.name).slice(0, 40)}" must be 1-32 letters, digits, _ or -`);
  return {
    name: e.name,
    config: parseConfig(e.config),
    enabled: e.enabled !== false,
    trusted: e.trusted === true,
    ...(typeof e.source === "string" ? { source: e.source } : {}),
    ...(typeof e.approvedLaunch === "string" ? { approvedLaunch: e.approvedLaunch } : {}),
    addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
  };
}
