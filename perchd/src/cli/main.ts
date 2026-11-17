/**
 * The `perch` command (spec 9.1): one-shot browser commands, sessions, clients, the MCP server
 * for agents, skill installers, and `perch serve`, which runs perchd itself.
 */

import { createInterface } from "node:readline/promises";
import guide from "../../skills/perch/guide.md" with { type: "text" };
import { closest, parseArgs, UsageError } from "./args";
import { DaemonNotRunning, NOT_RUNNING } from "./client";
import { browserCommands, sessionCommands } from "./commands";
import { SESSION_USAGE, taskCommands } from "./tasks";
import type { CliIO } from "./io";
import { APP_NEEDED, VERSION } from "../daemon/daemon";

export type { CliIO } from "./io";

const USAGE = `usage: perch [options] "<task>"      run a task in Perch (same as perch exec)
       perch <url>                     open a page in Perch
       perch <command> [args]          perch <command> --help for its options

Tasks (each is a Perch chat you can open, resume and steer):
  perch exec [-m model] [--effort low|medium|high|xhigh|max|ultra] [--permission ask|guard|full-access]
             [--timeout 5m] [--json] "<task>"
                                   only the answer goes to stdout; steps go to stderr
  perch session list | inspect <id> | resume <id> ["<follow-up>"] | steer <id> "<msg>"
                | queue <id> "<msg>" | stop <id> | delete <id> --yes | end [--sleep]
  perch models [--json]            the models a task can use, and the efforts each takes

Browser (in this terminal's own tab group, or PERCH_SESSION's; --session <name> for another):
  perch open <url> | navigate <url> | back | tabs
  perch snapshot [--full]          read the current tab; elements have refs like e12
  perch find <name> [--role button] [--contains]   refs for elements anywhere on the page
  perch scroll [down | up | <px>]  scroll the page, to read past what a snapshot shows
  perch click <ref> | type <ref> <text> [--submit] | select <ref> <option> | press <key>
  perch hover <ref>                move the mouse over an element, for menus and tooltips
  perch wait "<text>" [--timeout 10s] | wait --seconds <n>   wait for text, or a while
  perch switch <tab id>            work in another tab, by its id from perch tabs
  perch downloads                  files downloaded in the last hour, with their paths
  perch read <url | download path> [--from n]   the text of a PDF, .docx, .pptx, .xlsx or page
  perch screenshot [-o file.jpg]   save what the tab shows
  perch repl ["<js>"] [--reset]   a JavaScript session over your tabs, like aside repl:
                                   await openTab(url), snapshot(page), page.locator(ref).click();
                                   variables stay between runs. No code opens a prompt
  perch eval "<js>"                read the page with JavaScript (a read-only copy) and print the JSON result
  perch script "<js>"              run several browser steps in one go: await navigate(url),
                                   snapshot(), click(ref), type(ref, text), js(code), log(...)

Memory and skills (read only):
  perch memory search "<query>" [--limit n] [--json] | list [--json] | show <path> [--json]
  perch skills list [--json] | show <name>

Sessions and clients:
  perch status [--json]            whether perchd runs, and every agent session
  perch sessions [--json]          agent sessions and their tabs
  perch focus [--client C] [--session S]   bring a session's tabs forward
  perch clients [list | revoke <name> | allow <name> | mode <name> ask|guard|skip] [--json]
  perch transcript [--chat <id>] [--json] | --list   a chat's debug transcript (newest chat by default)

Agents:
  perch mcp [--client C] [--session S] [--agent A] [--title T] [--on-end close|sleep]
  perch skill install claude|codex|grok      add Perch's skill and MCP server
  perch skill uninstall claude|codex|grok
  perch guide                      how agents use Perch

  perch serve [--browser <path>] [--headless]   run perchd (normally started for you)
  perch --version | -v

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
  async models(argv, io) {
    const a = parseArgs(argv, { flags: ["--json"] });
    const { openDaemon } = await import("./io");
    const c = await openDaemon({ ...io, autostart: false });
    try {
      const list = await c.request<{ id: string; label: string; efforts: string[] }[]>("task.models");
      io.stdout(a.flags.has("--json") ? `${JSON.stringify(list, null, 2)}\n` : list.map((m) => `${m.id.padEnd(32)} ${m.label} (${m.efforts.join(", ")})\n`).join(""));
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
  // Not in the help: Perch's MCP server on a private browser, for `perch exec` when Perch isn't
  // running. The compiled binary has no src/mcp.ts on disk to run, so it runs it from here.
  async "mcp-private"(argv) {
    const { main } = await import("../mcp");
    await main(argv);
    return 0;
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
  if (name === "--version" || name === "-v" || name === "-V" || name === "version") {
    io.stdout(`perch ${VERSION}\n`);
    return 0;
  }
  if (Object.hasOwn(commands, name) && (rest.includes("--help") || rest.includes("-h"))) {
    io.stdout(name === "session" && rest[0] !== "end" ? `${SESSION_USAGE}\n` : (helpFor(name) ?? USAGE));
    return 0;
  }
  // Options before a task, as `perch -m codex/gpt-6.1-sol "<task>"` (Aside's form), mean exec.
  if (name.startsWith("-")) return run(commands.exec!, argv, io);
  // `perch <url>` opens it and `perch "<task>"` runs it, as `aside <url>` and `aside "<task>"` do.
  const looksLikeUrl = /^(https?:\/\/|[\w-]+(\.[\w-]+)+(\/|$))/i.test(name);
  const looksLikePrompt = /\s/.test(name.trim()) && !name.startsWith("-");
  // `perch "click e1"` is a browser command quoted by mistake, not a task: running it as one would
  // spend the person's plan on an agent. Commands that take a ref, and the script ones, are caught.
  const [first, second] = name.trim().split(/\s+/);
  const quotedCommand =
    looksLikePrompt && first !== undefined && Object.hasOwn(commands, first) &&
    (["eval", "script", "repl", "press", "screenshot", "snapshot"].includes(first) || (["click", "type", "select"].includes(first) && /^e\d+$/.test(second ?? "")));
  if (quotedCommand) {
    io.stderr(`perch: "${name.length > 60 ? `${name.slice(0, 60)}…` : name}" is a command, not a task. Run it without the quotes around the command: perch ${first} …\nTo hand it to the agent as a task, use perch exec "<task>".\n`);
    return 64;
  }
  const command: Command | undefined = Object.hasOwn(commands, name)
    ? commands[name]
    : looksLikeUrl
      ? (_rest, io2) => browserCommands.open!(argv, io2)
      : looksLikePrompt
        ? (_rest, io2) => commands.exec!(argv, io2)
        : undefined;
  if (!command) {
    const near = closest(name, Object.keys(commands).filter((c) => c !== "mcp-private"));
    io.stderr(`perch: unknown command "${name}".${near ? ` Did you mean perch ${near}?` : ""}\nRun perch --help to see every command.\n`);
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
      io.stderr(`${NOT_RUNNING}\n`);
      return 3;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\n`);
    // Perch's app isn't open: the same as perchd not running, for scripts that check.
    return message === APP_NEEDED ? 3 : 1;
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
