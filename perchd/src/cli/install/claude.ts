/** Perch's MCP server in Claude Code's user config (`~/.claude.json`, key `mcpServers.perch`). */

import { readText, writeSafely, type Change } from "./files";

export type McpEntry = { type: "stdio"; command: string; args: string[]; env: Record<string, never> };

export function claudeEntry(command: string[]): McpEntry {
  return { type: "stdio", command: command[0]!, args: [...command.slice(1), "mcp", "--client", "claude-code"], env: {} };
}

/** An entry Perch wrote: it runs `perch mcp --client …`. One the user made by hand is theirs. */
function isOurs(entry: unknown): boolean {
  const args = (entry as { args?: unknown })?.args;
  return Array.isArray(args) && args.includes("mcp") && args.includes("--client");
}

export function parseClaudeConfig(file: string, text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const data = JSON.parse(text);
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object");
    return data;
  } catch {
    throw new Error(`${file} is not valid JSON; Perch left it unchanged`);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function installClaudeServer(file: string, command: string[], now: Date): Change {
  const before = readText(file);
  const config = parseClaudeConfig(file, before);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const entry = claudeEntry(command);
  if (servers.perch !== undefined && !isOurs(servers.perch)) return { file, action: "skipped", note: "it already has a perch server you set up; left as is" };
  if (servers.perch !== undefined && same(servers.perch, entry)) return { file, action: "unchanged" };
  const next = { ...config, mcpServers: { ...servers, perch: entry } };
  return writeSafely(file, before, `${JSON.stringify(next, null, 2)}\n`, { now, newMode: 0o600 });
}

export function uninstallClaudeServer(file: string, now: Date): Change {
  const before = readText(file);
  if (before === null) return { file, action: "unchanged" };
  const config = parseClaudeConfig(file, before);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (servers.perch === undefined) return { file, action: "unchanged" };
  if (!isOurs(servers.perch)) return { file, action: "skipped", note: "its perch server was not added by Perch; left as is" };
  const { perch: _, ...rest } = servers;
  const change = writeSafely(file, before, `${JSON.stringify({ ...config, mcpServers: rest }, null, 2)}\n`, { now, newMode: 0o600 });
  return { ...change, action: "removed" };
}
