/**
 * The `perch` command (spec 9.1): one-shot browser commands, sessions, clients, the MCP server
 * for agents, skill installers, and `perch serve`, which runs perchd itself.
 */

import { createInterface } from "node:readline/promises";
import guide from "../../skills/perch/guide.md" with { type: "text" };
import { UsageError } from "./args";
import { DaemonNotRunning } from "./client";
import { browserCommands, sessionCommands } from "./commands";
import type { CliIO } from "./io";

export type { CliIO } from "./io";

const USAGE = `usage: perch <command>

  perch "<task>"                    hand a whole task to an agent (same as perch exec)

Browser (in this terminal window's own tab group, or PERCH_SESSION's; --session <name> for another):
  perch open <url>                 open a page in a new tab
  perch tabs                       every tab and who owns it
  perch snapshot [--full]          read the current tab
  perch click <ref> | type <ref> <text> [--submit] | press <key>
  perch screenshot [-o file.jpg]   save what the tab shows
  perch repl "<js>"                run JavaScript in the page
  perch exec [--model M] "<task>"  hand a whole task to an agent

Sessions and clients:
  perch status [--json]            whether perchd runs, and every agent session
  perch sessions [--json]          agent sessions and their tabs
  perch session end [--sleep]      close (or put to sleep) this terminal's tabs
  perch focus [--client C] [--session S]   bring a session's tabs forward
  perch clients [list | revoke <name> | allow <name> | mode <name> ask|guard|skip]

Agents:
  perch mcp [--client C] [--session S] [--agent A] [--title T] [--on-end close|sleep]
  perch skill install claude|codex|grok      add Perch's skill and MCP server
  perch skill uninstall claude|codex|grok
  perch guide                      how agents use Perch

  perch serve [--browser <path>] [--headless]   run perchd (normally started for you)
`;

type Command = (argv: string[], io: CliIO) => Promise<number>;

const commands: Record<string, Command> = {
  ...browserCommands,
  ...sessionCommands,
  async guide(_argv, io) {
    io.stdout(guide);
    return 0;
  },
  async mcp(argv, io) {
    const { runMcp } = await import("./mcp-proxy");
    return runMcp(argv, io);
  },
  async skill(argv, io) {
    const { skillCommand } = await import("./install/index");
    return skillCommand(argv, io);
  },
  async serve(argv, io) {
    const { serve } = await import("./serve");
    return serve(argv, io);
  },
  async exec(argv) {
    const { main: exec } = await import("../exec");
    return exec(argv);
  },
};

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    io.stdout(USAGE);
    return name ? 0 : 64;
  }
  // `perch <url>` opens it and `perch "<task>"` runs it, as `aside <url>` and `aside "<task>"` do.
  const looksLikeUrl = /^(https?:\/\/|[\w-]+(\.[\w-]+)+(\/|$))/i.test(name);
  const looksLikePrompt = /\s/.test(name.trim()) && !name.startsWith("-");
  const command: Command | undefined = Object.hasOwn(commands, name)
    ? commands[name]
    : looksLikeUrl
      ? (_rest, io2) => browserCommands.open!(argv, io2)
      : looksLikePrompt
        ? (_rest, io2) => commands.exec!(argv, io2)
        : undefined;
  if (!command) {
    io.stderr(`perch: unknown command "${name}"\n${USAGE}`);
    return 64;
  }
  try {
    return await command(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n`);
      return 64;
    }
    if (error instanceof DaemonNotRunning) {
      io.stderr("perchd is not running. Open Perch, or run any perch command to start it.\n");
      return 3;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function terminalIO(): CliIO {
  const tty = process.stdin.isTTY && process.stderr.isTTY;
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    ask: tty
      ? async (question) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
          } finally {
            rl.close();
          }
        }
      : undefined,
  };
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), terminalIO()));
