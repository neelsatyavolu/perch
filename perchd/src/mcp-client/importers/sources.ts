/**
 * Where each app keeps its MCP servers on a Mac, and a reader for each. A file that is missing is
 * skipped; a file that cannot be parsed is reported as a problem and the rest still import.
 */

import { readFile } from "node:fs/promises";
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

/** ~/.claude.json: user servers, per-project servers, and the project folders to look in for .mcp.json. */
function claudeJson(path: string, text: string): Found & { projects: string[] } {
  const data = JSON.parse(text) as Raw;
  const user = fromJsonMap("Claude Code (user)", path, data.mcpServers);
  const found: Found = { candidates: [...user.candidates], problems: [...user.problems] };
  const projects = isObject(data.projects) ? Object.keys(data.projects) : [];
  for (const dir of projects) {
    const entry = (data.projects as Raw)[dir];
    const p = fromJsonMap(`Claude Code (project ${basename(dir)})`, path, isObject(entry) ? entry.mcpServers : undefined);
    found.candidates.push(...p.candidates);
    found.problems.push(...p.problems);
  }
  return { ...found, projects };
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

  let projects: string[] = [];
  const claude = await readWith(join(home, ".claude.json"), (path, text) => {
    const r = claudeJson(path, text);
    projects = r.projects;
    return r;
  });
  const dirs = [...new Set([...projects, ...(opts.projectDirs ?? [])])];
  const fixed: [string, Reader][] = [
    [join(codexHome, "config.toml"), tomlServers("Codex")],
    [join(grokHome, "config.toml"), tomlServers("Grok")],
    [join(appSupport, "Claude", "claude_desktop_config.json"), jsonServers("Claude Desktop", "mcpServers")],
    [join(home, ".cursor", "mcp.json"), jsonServers("Cursor", "mcpServers")],
    [join(appSupport, "Code", "User", "mcp.json"), jsonServers("VS Code", "servers", { vscode: true })],
    [join(appSupport, "Code - Insiders", "User", "mcp.json"), jsonServers("VS Code Insiders", "servers", { vscode: true })],
  ];
  const perProject: [string, Reader][] = dirs.flatMap((dir): [string, Reader][] => [
    [join(dir, ".mcp.json"), jsonServers(`Claude Code (.mcp.json in ${basename(dir)})`, "mcpServers")],
    [join(dir, ".cursor", "mcp.json"), jsonServers(`Cursor (project ${basename(dir)})`, "mcpServers")],
    [join(dir, ".vscode", "mcp.json"), jsonServers(`VS Code (project ${basename(dir)})`, "servers", { vscode: true, workspace: dir })],
  ]);
  const rest = await Promise.all([...fixed, ...perProject].map(([path, reader]) => readWith(path, reader)));
  return {
    candidates: [claude, ...rest].flatMap((f) => f.candidates),
    problems: [claude, ...rest].flatMap((f) => f.problems),
  };
}
