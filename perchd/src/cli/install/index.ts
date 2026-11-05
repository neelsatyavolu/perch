/**
 * `perch skill install|uninstall claude|codex|grok` (spec 9.1): the Perch skill and MCP server
 * for an agent CLI. Each change backs up the file first; running it twice changes nothing.
 */

import { existsSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import skill from "../../../skills/perch/SKILL.md" with { type: "text" };
import { parseArgs, UsageError } from "../args";
import type { CliIO } from "../io";
import { selfCommand } from "../self";
import { installClaudeServer, parseClaudeConfig, uninstallClaudeServer } from "./claude";
import { readText, writeSafely, type Change } from "./files";
import { checkToml, installTomlServer, uninstallTomlServer } from "./toml";

export type Agent = "claude" | "codex" | "grok";
export type InstallEnv = { home: string; env: Record<string, string | undefined>; command: string[]; now?: () => Date };

const AGENTS: readonly Agent[] = ["claude", "codex", "grok"];
const MARK = "installed-by: perch";

function locations(agent: Agent, ienv: InstallEnv): { config: string; skillFile: string } {
  const { home, env } = ienv;
  if (agent === "claude") {
    const dir = env.CLAUDE_CONFIG_DIR;
    return { config: dir ? join(dir, ".claude.json") : join(home, ".claude.json"), skillFile: join(dir ?? join(home, ".claude"), "skills", "perch", "SKILL.md") };
  }
  const dir = agent === "codex" ? env.CODEX_HOME || join(home, ".codex") : env.GROK_HOME || join(home, ".grok");
  return { config: join(dir, "config.toml"), skillFile: join(dir, "skills", "perch", "SKILL.md") };
}

function installSkill(file: string, now: Date): Change {
  const before = readText(file);
  if (before !== null && !before.includes(MARK)) return { file, action: "skipped", note: "a perch skill you wrote is already there; left as is" };
  return writeSafely(file, before, skill, { now, newMode: 0o644 });
}

function uninstallSkill(file: string): Change {
  const before = readText(file);
  if (before === null) return { file, action: "unchanged" };
  if (!before.includes(MARK)) return { file, action: "skipped", note: "this perch skill was not added by Perch; left as is" };
  rmSync(file);
  try {
    rmdirSync(dirname(file));
  } catch {
    // The folder has other files of the user's; keep it.
  }
  return { file, action: "removed" };
}

export function install(agent: Agent, ienv: InstallEnv): Change[] {
  const now = (ienv.now ?? (() => new Date()))();
  const where = locations(agent, ienv);
  const server = agent === "claude" ? () => installClaudeServer(where.config, ienv.command, now) : () => installTomlServer(where.config, agent, ienv.command, now);
  // The config is checked first, so a broken file stops the install before anything is written.
  if (agent === "claude") parseClaudeConfig(where.config, readText(where.config));
  else if (existsSync(where.config)) checkToml(where.config, readText(where.config) ?? "");
  const skillChange = installSkill(where.skillFile, now);
  return [skillChange, server()];
}

export function uninstall(agent: Agent, ienv: InstallEnv): Change[] {
  const now = (ienv.now ?? (() => new Date()))();
  const where = locations(agent, ienv);
  const server = agent === "claude" ? uninstallClaudeServer(where.config, now) : uninstallTomlServer(where.config, now);
  return [uninstallSkill(where.skillFile), server];
}

function describe(change: Change): string {
  const what = change.file.endsWith("SKILL.md") ? "Skill" : "MCP server in";
  const backup = change.backup ? ` (backup: ${change.backup})` : "";
  const note = change.note ? `: ${change.note}` : "";
  const verb = { created: "Added", updated: "Added", unchanged: "Already up to date", removed: "Removed", skipped: "Skipped" }[change.action];
  return `${verb}: ${what} ${change.file}${backup}${note}\n`;
}

export async function skillCommand(argv: string[], io: CliIO): Promise<number> {
  const [action, agent] = parseArgs(argv).positionals;
  if ((action !== "install" && action !== "uninstall") || !AGENTS.includes(agent as Agent)) {
    throw new UsageError("usage: perch skill install|uninstall claude|codex|grok");
  }
  const ienv: InstallEnv = { home: io.env.HOME || homedir(), env: io.env, command: selfCommand() };
  const changes = action === "install" ? install(agent as Agent, ienv) : uninstall(agent as Agent, ienv);
  for (const change of changes) io.stdout(describe(change));
  if (action === "install") io.stdout(`Restart ${agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Grok"} to load it.\n`);
  return 0;
}
