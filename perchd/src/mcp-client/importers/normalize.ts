/**
 * Turns one server entry from another app's config into Perch's shape. Values stay raw here (they
 * may be secrets); they only exist in memory until save moves them into the Keychain.
 */

import type { ServerConfig, Value } from "../types";

export type Candidate = {
  /** Which app and scope, such as "Claude Code (project perch)". */
  source: string;
  /** The config file it came from. */
  path: string;
  name: string;
  config: ServerConfig;
  enabled: boolean;
  warnings: string[];
  /** From a config file inside a project folder, which whoever can change the folder can edit. */
  projectFile?: boolean;
  /** For a project-file server: whether the user approved it in its own app. */
  approved?: boolean;
};

export type Problem = { path: string; message: string };

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Index of the next character that is not white space or inside a comment. */
function nextSignificant(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) i++;
    else if (text.startsWith("//", i)) while (i < text.length && text[i] !== "\n") i++;
    else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else return i;
  }
  return i;
}

/** Comments and trailing commas, as VS Code and Cursor allow in their JSON files. Strings are left as they are. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = nextSignificant(text, i);
    } else if (c === "," && (text[nextSignificant(text, i + 1)] === "}" || text[nextSignificant(text, i + 1)] === "]")) {
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

/** VS Code's ${env:X} becomes ${X}; ${input:x} cannot be read and is reported. */
function vscodeValue(v: string, warnings: string[], where: string, workspace?: string): string | null {
  if (/\$\{input:[^}]+\}/.test(v)) {
    warnings.push(`${where} asks VS Code for a value at start-up; enter it in Perch after importing.`);
    return null;
  }
  let out = v.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
  if (out.includes("${workspaceFolder}")) {
    if (workspace) out = out.replaceAll("${workspaceFolder}", workspace);
    else warnings.push(`${where} uses \${workspaceFolder}; check the path after importing.`);
  }
  return out;
}

function stringMap(raw: unknown, warnings: string[], where: string, vscode: boolean, workspace?: string): Record<string, Value> {
  if (!isObject(raw)) return {};
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    const value = vscode ? vscodeValue(String(v), warnings, `${where} ${k}`, workspace) : String(v);
    if (value !== null) out[k] = value;
  }
  return out;
}

function transportOf(type: unknown, hasUrl: boolean): "stdio" | "http" | "sse" | null {
  const t = typeof type === "string" ? type.toLowerCase().replace(/[-_]/g, "") : "";
  if (t === "sse") return "sse";
  if (t === "http" || t === "streamablehttp") return "http";
  if (t === "stdio") return "stdio";
  if (t) return null;
  return hasUrl ? "http" : "stdio";
}

/** The mcpServers / servers entry shape shared by Claude Code, Claude Desktop, Cursor and VS Code. */
export function fromJsonEntry(raw: unknown, ctx: { vscode?: boolean; workspace?: string } = {}): { config: ServerConfig; enabled: boolean; warnings: string[] } | string {
  if (!isObject(raw)) return "the entry is not an object";
  const warnings: string[] = [];
  const hasUrl = typeof raw.url === "string" || typeof raw.serverUrl === "string";
  const transport = transportOf(raw.type ?? raw.transport, hasUrl);
  if (!transport) return `the transport "${String(raw.type ?? raw.transport).slice(0, 30)}" is not supported`;
  const enabled = raw.disabled !== true && raw.enabled !== false;
  if (raw.envFile) warnings.push("The server reads an env file, which Perch does not import; add those values after importing.");
  if (transport === "stdio") {
    if (typeof raw.command !== "string" || !raw.command.trim()) return "the entry has no command";
    const args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === "string" || typeof a === "number").map(String) : [];
    const fixedArgs = ctx.vscode ? args.map((a, i) => vscodeValue(a, warnings, `argument ${i + 1}`, ctx.workspace) ?? "") : args;
    const cwd = typeof raw.cwd === "string" ? (ctx.vscode ? vscodeValue(raw.cwd, warnings, "cwd", ctx.workspace) : raw.cwd) : null;
    return {
      config: { transport, command: raw.command, args: fixedArgs, env: stringMap(raw.env, warnings, "env", Boolean(ctx.vscode), ctx.workspace), ...(cwd ? { cwd } : {}) },
      enabled,
      warnings,
    };
  }
  const url = String(raw.url ?? raw.serverUrl);
  if (typeof raw.headersHelper === "string") warnings.push("Claude Code runs a command (headersHelper) to make this server's headers. Perch does not run it; add the headers after importing.");
  const oauth = isObject(raw.oauth) && typeof raw.oauth.clientId === "string" ? { clientId: raw.oauth.clientId, ...(typeof raw.oauth.callbackPort === "number" ? { callbackPort: raw.oauth.callbackPort } : {}) } : null;
  return { config: { transport, url, headers: stringMap(raw.headers, warnings, "header", Boolean(ctx.vscode), ctx.workspace), ...(oauth ? { oauth } : {}) }, enabled, warnings };
}

/** Codex and Grok [mcp_servers.<name>] tables. */
export function fromTomlEntry(raw: unknown): { config: ServerConfig; enabled: boolean; warnings: string[] } | string {
  if (!isObject(raw)) return "the entry is not a table";
  const warnings: string[] = [];
  const enabled = raw.enabled !== false && raw.disabled !== true;
  if (typeof raw.url === "string") {
    const headers: Record<string, Value> = { ...stringMap(raw.http_headers, warnings, "header", false), ...stringMap(raw.headers, warnings, "header", false) };
    if (isObject(raw.env_http_headers)) for (const [h, v] of Object.entries(raw.env_http_headers)) if (typeof v === "string") headers[h] = `\${${v}}`;
    if (typeof raw.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${raw.bearer_token_env_var}}`;
    if (typeof raw.bearer_token === "string") headers.Authorization = `Bearer ${raw.bearer_token}`;
    return { config: { transport: "http", url: raw.url, headers }, enabled, warnings };
  }
  if (typeof raw.command !== "string" || !raw.command.trim()) return "the entry has no command or url";
  const env: Record<string, Value> = stringMap(raw.env, warnings, "env", false);
  if (Array.isArray(raw.env_vars)) for (const v of raw.env_vars) if (typeof v === "string" && !(v in env)) env[v] = { env: v };
  const args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === "string" || typeof a === "number").map(String) : [];
  return { config: { transport: "stdio", command: raw.command, args, env, ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}) }, enabled, warnings };
}
