/**
 * Where each app keeps its MCP servers on a Mac, and a reader for each. A file that is missing is
 * skipped; a file that cannot be parsed is reported as a problem and the rest still import.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { fromJsonEntry, fromTomlEntry, parseJsonc, type Candidate, type Problem } from "./normalize";

export type FindOptions = {
  home: string;
  /** Extra project folders to look in for .mcp.json, .cursor/mcp.json and .vscode/mcp.json. */
  projectDirs?: string[];
  env?: Record<string, string | undefined>;
};

export type Found = { candidates: Candidate[]; problems: Problem[] };

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => Boolean(v) && typeof v === "object" && !Array.isArray(v);

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

type Reader = (path: string, text: string) => { candidates: Candidate[]; problems: Problem[] };

function jsonServers(source: string, key: "mcpServers" | "servers", ctx: { vscode?: boolean; workspace?: string } = {}): Reader {
  return (path, text) => {
    const data = parseJsonc(text);
    return fromJsonMap(source, path, isObject(data) ? data[key] : undefined, ctx);
  };
}

/** VS Code's settings.json keeps servers under "mcp": { "servers": ... }. */
function vscodeSettings(source: string): Reader {
  return (path, text) => {
    const data = parseJsonc(text);
    const mcp = isObject(data) ? data.mcp : undefined;
    return fromJsonMap(source, path, isObject(mcp) ? mcp.servers : undefined, { vscode: true });
  };
}

/** VS Code and Insiders: the default profile's mcp.json and settings.json, then each named profile's. */
async function vscodeFiles(appSupport: string): Promise<[string, Reader][]> {
  const apps: [string, string][] = [["Code", "VS Code"], ["Code - Insiders", "VS Code Insiders"]];
  const perApp = await Promise.all(
    apps.map(async ([folder, label]): Promise<[string, Reader][]> => {
      const user = join(appSupport, folder, "User");
      const profiles = (await readdir(join(user, "profiles"), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name).sort();
      const scopes: [string, string][] = [[user, label], ...profiles.map((p): [string, string] => [join(user, "profiles", p), `${label} (profile ${p})`])];
      return scopes.flatMap(([dir, source]): [string, Reader][] => [
        [join(dir, "mcp.json"), jsonServers(source, "servers", { vscode: true })],
        [join(dir, "settings.json"), vscodeSettings(source)],
      ]);
    }),
  );
  return perApp.flat();
}

function fromJsonMap(source: string, path: string, map: unknown, ctx: { vscode?: boolean; workspace?: string } = {}): Found {
  const out: Found = { candidates: [], problems: [] };
  if (!isObject(map)) return out;
  for (const [name, raw] of Object.entries(map)) {
    const r = fromJsonEntry(raw, ctx);
    if (typeof r === "string") out.problems.push({ path, message: `${name}: ${r}` });
    else out.candidates.push({ source, path, name, ...r });
  }
  return out;
}

function tomlServers(source: string): Reader {
  return (path, text) => {
    const data = parseToml(text) as Raw;
    const out: Found = { candidates: [], problems: [] };
    const disabled = new Set(Array.isArray(data.disabled_mcp_servers) ? data.disabled_mcp_servers.map(String) : []);
    if (!isObject(data.mcp_servers)) return out;
    for (const [name, raw] of Object.entries(data.mcp_servers)) {
      const r = fromTomlEntry(raw);
      if (typeof r === "string") out.problems.push({ path, message: `${name}: ${r}` });
      else out.candidates.push({ source, path, name, ...r, enabled: r.enabled && !disabled.has(name) });
    }
    return out;
  };
}

/** Claude Code's answers about a project's .mcp.json servers (set when the user approves or rejects them). */
type McpjsonApproval = { all: boolean; enabled: ReadonlySet<string>; disabled: ReadonlySet<string> };

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function approvalOf(...scopes: unknown[]): McpjsonApproval {
  const objs = scopes.filter(isObject);
  return {
    all: objs.some((o) => o.enableAllProjectMcpServers === true),
    enabled: new Set(objs.flatMap((o) => names(o.enabledMcpjsonServers))),
    disabled: new Set(objs.flatMap((o) => names(o.disabledMcpjsonServers))),
  };
}

const PROJECT_FILE_NOTE = "It comes from a file in the project folder, which anyone who can change that folder can edit; check it before importing.";

/** Marks servers from a project folder's file, and applies Claude Code's approvals to .mcp.json servers. */
function fromProjectFile(found: Found, approval?: McpjsonApproval): Found {
  const candidates = found.candidates.map((c): Candidate => {
    if (!approval) return { ...c, projectFile: true, approved: false, warnings: [...c.warnings, PROJECT_FILE_NOTE] };
    if (approval.disabled.has(c.name)) return { ...c, projectFile: true, approved: false, enabled: false, warnings: [...c.warnings, "You turned this project server down in Claude Code."] };
    if (approval.all || approval.enabled.has(c.name)) return { ...c, projectFile: true, approved: true };
    return { ...c, projectFile: true, approved: false, warnings: [...c.warnings, `Claude Code has not approved this project server. ${PROJECT_FILE_NOTE}`] };
  });
  return { candidates, problems: found.problems };
}

/** ~/.claude.json: user servers, per-project servers, and the project folders to look in for .mcp.json. */
function claudeJson(path: string, text: string, userSettings: unknown): Found & { approvals: ReadonlyMap<string, McpjsonApproval> } {
  const data = JSON.parse(text) as Raw;
  const user = fromJsonMap("Claude Code (user)", path, data.mcpServers);
  const found: Found = { candidates: [...user.candidates], problems: [...user.problems] };
  const projects = isObject(data.projects) ? Object.keys(data.projects) : [];
  const approvals = new Map<string, McpjsonApproval>();
  for (const dir of projects) {
    const entry = (data.projects as Raw)[dir];
    const off = new Set(isObject(entry) ? names(entry.disabledMcpServers) : []);
    const p = fromJsonMap(`Claude Code (project ${basename(dir)})`, path, isObject(entry) ? entry.mcpServers : undefined);
    found.candidates.push(...p.candidates.map((c) => ({ ...c, enabled: c.enabled && !off.has(c.name) })));
    found.problems.push(...p.problems);
    approvals.set(dir, approvalOf(userSettings, entry));
  }
  return { ...found, approvals };
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

async function readWith(path: string, reader: Reader): Promise<Found> {
  const text = await readText(path);
  if (text === null) return { candidates: [], problems: [] };
  try {
    return reader(path, text);
  } catch (error) {
    // Parser messages quote the offending line, which may hold a secret: report only where it is.
    const line = (error as { line?: unknown }).line;
    return { candidates: [], problems: [{ path, message: `is not valid ${path.endsWith(".toml") ? "TOML" : "JSON"}${typeof line === "number" ? ` (line ${line})` : ""}; nothing was imported from it` }] };
  }
}

export async function findImports(opts: FindOptions): Promise<Found> {
  const env = opts.env ?? {};
  const { home } = opts;
  const appSupport = join(home, "Library", "Application Support");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const grokHome = env.GROK_HOME || join(home, ".grok");

  // Only the user's own settings count for approvals: a project's checked-in settings could approve itself.
  const userSettings = await readJson(join(home, ".claude", "settings.json"));
  let approvals: ReadonlyMap<string, McpjsonApproval> = new Map();
  const claude = await readWith(join(home, ".claude.json"), (path, text) => {
    const r = claudeJson(path, text, userSettings);
    approvals = r.approvals;
    return r;
  });
  const dirs = [...new Set([...approvals.keys(), ...(opts.projectDirs ?? [])])];
  const fixed: [string, Reader][] = [
    [join(codexHome, "config.toml"), tomlServers("Codex")],
    [join(grokHome, "config.toml"), tomlServers("Grok")],
    [join(appSupport, "Claude", "claude_desktop_config.json"), jsonServers("Claude Desktop", "mcpServers")],
    [join(home, ".cursor", "mcp.json"), jsonServers("Cursor", "mcpServers")],
    ...(await vscodeFiles(appSupport)),
  ];
  const inProject = (reader: Reader, approval?: McpjsonApproval): Reader => (path, text) => fromProjectFile(reader(path, text), approval);
  const perProject: [string, Reader][] = dirs.flatMap((dir): [string, Reader][] => [
    [join(dir, ".mcp.json"), inProject(jsonServers(`Claude Code (.mcp.json in ${basename(dir)})`, "mcpServers"), approvals.get(dir) ?? approvalOf(userSettings))],
    [join(dir, ".cursor", "mcp.json"), inProject(jsonServers(`Cursor (project ${basename(dir)})`, "mcpServers"))],
    [join(dir, ".vscode", "mcp.json"), inProject(jsonServers(`VS Code (project ${basename(dir)})`, "servers", { vscode: true, workspace: dir }))],
  ]);
  const rest = await Promise.all([...fixed, ...perProject].map(([path, reader]) => readWith(path, reader)));
  return {
    candidates: [claude, ...rest].flatMap((f) => f.candidates),
    problems: [claude, ...rest].flatMap((f) => f.problems),
  };
}
