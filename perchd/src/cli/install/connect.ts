/**
 * One click from the tour: the `perch` command on PATH, and Perch's skill and MCP server in each
 * agent CLI found on this Mac (Claude Code, Codex, Grok). The command is a link in ~/.local/bin;
 * when no shell startup file puts that folder on PATH, one line is added to the login file of the
 * user's shell. Nothing is overwritten that Perch didn't make.
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { install, type Agent, type InstallEnv } from "./index";

export type AgentState = { readonly id: Agent; readonly found: boolean; readonly installed: boolean; readonly error?: string };
export type CommandState = { readonly installed: boolean; readonly path: string; readonly shellFile?: string; readonly note?: string };

const MARK = "installed-by: perch";
const PATH_LINE = '\n# Added by Perch: the perch command\nexport PATH="$HOME/.local/bin:$PATH"\n';
const SHELL_FILES = [".zprofile", ".zshrc", ".zshenv", ".bash_profile", ".bashrc", ".profile"];

function agentDir(agent: Agent, ienv: InstallEnv): string {
  const { home, env } = ienv;
  if (agent === "claude") return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return agent === "codex" ? env.CODEX_HOME || join(home, ".codex") : env.GROK_HOME || join(home, ".grok");
}

/** An agent CLI counts as on this Mac when its config folder is (each makes it on first run). */
export function agentFound(agent: Agent, ienv: InstallEnv): boolean {
  return existsSync(agentDir(agent, ienv)) || (agent === "claude" && existsSync(join(ienv.home, ".claude.json")));
}

export function agentInstalled(agent: Agent, ienv: InstallEnv): boolean {
  try {
    return readFileSync(join(agentDir(agent, ienv), "skills", "perch", "SKILL.md"), "utf8").includes(MARK);
  } catch {
    return false;
  }
}

export function agentStates(agents: readonly Agent[], ienv: InstallEnv): AgentState[] {
  return agents.map((id) => ({ id, found: agentFound(id, ienv), installed: agentInstalled(id, ienv) }));
}

const commandPath = (home: string) => join(home, ".local", "bin", "perch");

/** The login file Perch adds the PATH line to, or none when a startup file already names ~/.local/bin. */
function shellFileToChange(home: string, shell: string | undefined): string | null {
  for (const name of SHELL_FILES) {
    try {
      if (readFileSync(join(home, name), "utf8").includes(".local/bin")) return null;
    } catch {
      // Not there.
    }
  }
  return join(home, basename(shell ?? "") === "bash" ? ".bash_profile" : ".zprofile");
}

export function commandState(ienv: InstallEnv): CommandState {
  const path = commandPath(ienv.home);
  try {
    const target = readlinkSync(path);
    return { installed: target === ienv.command[0], path };
  } catch {
    return { installed: false, path };
  }
}

/** Links ~/.local/bin/perch to Perch's own binary and makes sure the folder is on PATH. */
export function installCommand(ienv: InstallEnv): CommandState {
  const path = commandPath(ienv.home);
  const [binary, ...rest] = ienv.command;
  if (!binary || rest.length > 0) return { installed: false, path, note: "A development build of Perch can't install the perch command" };
  if (existsSync(path) || isLink(path)) {
    let target: string | null = null;
    try {
      target = readlinkSync(path);
    } catch {
      return { installed: false, path, note: "A perch command that Perch didn't make is already there; left as is" };
    }
    if (target === binary) return withPath({ installed: true, path }, ienv);
    // An older Perch's link (another version folder, another copy of the app) is replaced.
    if (!/\/perchd$/.test(target)) return { installed: false, path, note: "A perch command that Perch didn't make is already there; left as is" };
    unlinkSync(path);
  }
  mkdirSync(join(ienv.home, ".local", "bin"), { recursive: true });
  symlinkSync(binary, path);
  return withPath({ installed: true, path }, ienv);
}

function withPath(state: CommandState, ienv: InstallEnv): CommandState {
  const file = shellFileToChange(ienv.home, ienv.env.SHELL);
  if (!file) return state;
  appendFileSync(file, PATH_LINE, { mode: 0o644 });
  return { ...state, shellFile: file };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Installs the command, then Perch into every agent found. One agent's broken config doesn't stop the rest. */
export function connectAgents(agents: readonly Agent[], ienv: InstallEnv): { command: CommandState; agents: AgentState[] } {
  const command = installCommand(ienv);
  const states = agents.map((id): AgentState => {
    if (!agentFound(id, ienv)) return { id, found: false, installed: false };
    try {
      install(id, ienv);
      return { id, found: true, installed: agentInstalled(id, ienv) };
    } catch (error) {
      return { id, found: true, installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return { command, agents: states };
}
