/**
 * The `perch` command (spec 9.1): one-shot browser commands, sessions, clients, the MCP server
 * for agents, skill installers, and `perch serve`, which runs perchd itself.
 */

import { createInterface } from "node:readline/promises";
import guide from "../../skills/perch/guide.md" with { type: "text" };
import { UsageError } from "./args";
import { DaemonNotRunning } from "./client";
import { browserCommands, sessionCommands } from "./commands";
import { taskCommands } from "./tasks";
import { VERSION } from "../daemon/daemon";
import type { CliIO } from "./io";

export type { CliIO } from "./io";

const USAGE = `usage: perch [options] "<task>"      run a task in Perch (same as perch exec)
       perch <url>                     open a page in Perch
       perch <command> [args]          perch <command> --help for its options

Tasks (each is a Perch chat you can open, resume and steer):
  perch exec [-m model] [--effort low|medium|high] [--permission ask|guard|full-access]
             [--timeout 5m] [--json] "<task>"
                                   only the answer goes to stdout; steps go to stderr
  perch session list | inspect <id> | resume <id> ["<follow-up>"] | steer <id> "<msg>"
                | queue <id> "<msg>" | stop <id> | delete <id> --yes | end [--sleep]
  perch models                     the models a task can use

Browser (in this terminal's own tab group, or PERCH_SESSION's; --session <name> for another):
  perch open <url> | navigate <url> | back | tabs
  perch snapshot [--full]          read the current tab; elements have refs like e12
  perch click <ref> | type <ref> <text> [--submit] | select <ref> <option> | press <key>
  perch screenshot [-o file.jpg]   save what the tab shows
  perch repl "<js>"                run JavaScript in the page and print its JSON result
  perch script "<js>"              run several browser steps in one go: await navigate(url),
                                   snapshot(), click(ref), type(ref, text), js(code), log(...)

Memory and skills (read only):
  perch memory search "<query>" [--json] | list | show <path>
  perch skills list | show <name>

Sessions and clients:
  perch status [--json]            whether perchd runs, and every agent session
  perch sessions [--json]          agent sessions and their tabs
  perch focus [--client C] [--session S]   bring a session's tabs forward
  perch clients [list | revoke <name> | allow <name> | mode <name> ask|guard|skip]

Agents:
  perch mcp [--client C] [--session S] [--agent A] [--title T] [--on-end close|sleep]
  perch skill install claude|codex|grok      add Perch's skill and MCP server
  perch skill uninstall claude|codex|grok
  perch guide                      how agents use Perch

  perch serve [--browser <path>] [--headless]   run perchd (normally started for you)
  perch --version

Exit codes: 0 done, 1 failed or --timeout passed (the task keeps running), 64 bad usage,
3 Perch not running, 130 stopped with Ctrl-C.
`;

/** `perch <command> --help`: the lines of the usage that name the command. */
function helpFor(name: string): string | null {
  const lines = USAGE.split("\n");
  const picked: string[] = [];
  lines.forEach((line, i) => {
    if (new RegExp(`perch ${name}\\b|\\| ${name}\\b`).test(line)) {
      picked.push(line);
      for (let j = i + 1; j < lines.length && /^\s{13,}\S/.test(lines[j]!) && !/perch /.test(lines[j]!); j++) picked.push(lines[j]!);
    }
  });
  return picked.length ? `${picked.join("\n")}\n` : null;
}

type Command = (argv: string[], io: CliIO) => Promise<number>;

const commands: Record<string, Command> = {
  ...browserCommands,
  ...sessionCommands,
  ...taskCommands,
  // `perch session end` closes this terminal's tabs; every other `perch session` verb is about tasks.
  async session(argv, io) {
    return argv[0] === "end" ? sessionCommands.session!(argv, io) : taskCommands.session!(argv, io);
  },
  async models(_argv, io) {
    const { openDaemon } = await import("./io");
    const c = await openDaemon({ ...io, autostart: false });
    try {
      const list = await c.request<{ id: string; label: string; efforts: string[] }[]>("task.models");
      io.stdout(list.map((m) => `${m.id.padEnd(32)} ${m.label} (${m.efforts.join(", ")})\n`).join(""));
      return 0;
    } finally {
      c.close();
    }
  },
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
};

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const topic = name === "help" ? rest[0] : undefined;
    io.stdout((topic && helpFor(topic)) || USAGE);
    return name ? 0 : 64;
  }
  if (name === "--version" || name === "-V" || name === "version") {
    io.stdout(`perch ${VERSION}\n`);
    return 0;
  }
  if (Object.hasOwn(commands, name) && (rest.includes("--help") || rest.includes("-h"))) {
    io.stdout(helpFor(name) ?? USAGE);
    return 0;
  }
  // Options before a task, as `perch -m codex/gpt-6.1-sol "<task>"` (Aside's form), mean exec.
  if (name.startsWith("-")) return run(commands.exec!, argv, io);
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
  return run(command, rest, io);
}

async function run(command: Command, rest: string[], io: CliIO): Promise<number> {
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
