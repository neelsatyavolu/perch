/** One-shot browser and session commands: each connects, does one thing, and disconnects. */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClientRecord } from "../daemon/clients";
import type { SessionSummary } from "../daemon/sessions";
import { parseArgs, UsageError } from "./args";
import type { DaemonClient } from "./client";
import { openDaemon, type CliIO } from "./io";

type ToolResult = { content: string; image?: string; isError?: boolean };
type Status = { client: string; mode: string; session: string; label: string; pid: number; socket: string; sessions: SessionSummary[] };

const SESSION = ["--session"];

async function withDaemon<T>(io: CliIO, session: string | undefined, run: (c: DaemonClient) => Promise<T>, client?: string): Promise<T> {
  const c = await openDaemon(io, { session, client });
  try {
    return await run(c);
  } finally {
    c.close();
  }
}

/** Runs one tool in the terminal's session and prints its text; 1 when the tool failed. */
async function tool(io: CliIO, session: string | undefined, name: string, args: Record<string, unknown>): Promise<number> {
  const result = await withDaemon(io, session, (c) => c.request<ToolResult>("call", { name, args }));
  (result.isError ? io.stderr : io.stdout)(`${result.content}\n`);
  return result.isError ? 1 : 0;
}

function one(positionals: string[], usage: string, count = 1): string[] {
  if (positionals.length < count) throw new UsageError(`usage: ${usage}`);
  return positionals;
}

export const browserCommands: Record<string, (argv: string[], io: CliIO) => Promise<number>> = {
  async open(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [url] = one(a.positionals, "perch open <url> [--session <name>]");
    return tool(io, a.options.get("--session"), "open_tab", { url });
  },
  async snapshot(argv, io) {
    const a = parseArgs(argv, { flags: ["--full"], options: SESSION });
    return tool(io, a.options.get("--session"), "snapshot", { full: a.flags.has("--full") });
  },
  async click(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [ref] = one(a.positionals, "perch click <ref>");
    return tool(io, a.options.get("--session"), "click", { ref });
  },
  async type(argv, io) {
    const a = parseArgs(argv, { flags: ["--submit"], options: SESSION });
    const [ref, ...text] = one(a.positionals, "perch type <ref> <text> [--submit]", 2);
    return tool(io, a.options.get("--session"), "type", { ref, text: text.join(" "), submit: a.flags.has("--submit") });
  },
  async press(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [key] = one(a.positionals, "perch press <key>");
    return tool(io, a.options.get("--session"), "press", { key });
  },
  async script(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const code = one(a.positionals, 'perch script "<javascript calling navigate(), snapshot(), click(), js() …>"').join(" ");
    return tool(io, a.options.get("--session"), "script", { code });
  },
  async navigate(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [url] = one(a.positionals, "perch navigate <url>");
    return tool(io, a.options.get("--session"), "navigate", { url });
  },
  async select(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [ref, ...value] = one(a.positionals, "perch select <ref> <option>", 2);
    return tool(io, a.options.get("--session"), "select", { ref, value: value.join(" ") });
  },
  async back(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    return tool(io, a.options.get("--session"), "back", {});
  },
  /** JavaScript in the page itself, with its JSON result (what `perch repl` did before it became a session). */
  async eval(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const code = one(a.positionals, 'perch eval "<javascript run in the page>"').join(" ");
    return tool(io, a.options.get("--session"), "repl", { code });
  },
  async repl(argv, io) {
    const a = parseArgs(argv, { flags: ["--reset"], options: SESSION });
    const session = a.options.get("--session");
    if (a.flags.has("--reset")) {
      const r = await withDaemon(io, session, (c) => c.request<{ reset: boolean }>("repl.reset"));
      io.stdout(r.reset ? "Cleared this session's REPL.\n" : "This session has no REPL yet.\n");
      return 0;
    }
    const given = a.positionals.join(" ").trim();
    if (given) return replRun(io, session, given);
    if (!process.stdin.isTTY) return replRun(io, session, await Bun.stdin.text());
    return replLoop(io, session);
  },
  async screenshot(argv, io) {
    const a = parseArgs(argv, { options: [...SESSION, "-o", "--output"] });
    const result = await withDaemon(io, a.options.get("--session"), (c) => c.request<ToolResult>("call", { name: "screenshot", args: {} }));
    if (result.isError || !result.image) {
      io.stderr(`${result.content}\n`);
      return 1;
    }
    const file = resolve(io.cwd, a.options.get("-o") ?? a.options.get("--output") ?? `perch-screenshot-${Date.now()}.jpg`);
    writeFileSync(file, Buffer.from(result.image, "base64"), { mode: 0o600 });
    io.stdout(`Saved ${file}\n`);
    return 0;
  },
  async tabs(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    io.stdout(`${await withDaemon(io, a.options.get("--session"), (c) => c.request<string>("tabs"))}\n`);
    return 0;
  },
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatSessions(list: SessionSummary[]): string {
  if (!list.length) return "No agent sessions.\n";
  return list.map((s) => `${s.label}  ${plural(s.tabs, "tab")}${s.asleep ? ", asleep" : ""}  (${s.client}/${s.session})\n`).join("");
}

function formatClients(list: ClientRecord[]): string {
  if (!list.length) return "No clients yet.\n";
  return list.map((c) => `${c.name.padEnd(14)} ${c.revoked ? "revoked" : c.mode.padEnd(6)} last used ${c.lastUsed ?? "never"}\n`).join("");
}

export const sessionCommands: Record<string, (argv: string[], io: CliIO) => Promise<number>> = {
  async status(argv, io) {
    const a = parseArgs(argv, { flags: ["--json"] });
    const status = await withDaemon({ ...io, autostart: false }, undefined, (c) => c.request<Status>("status"));
    if (a.flags.has("--json")) io.stdout(`${JSON.stringify(status, null, 2)}\n`);
    else io.stdout(`perchd is running (pid ${status.pid}).\nThis terminal: ${status.label}, ${status.mode} mode.\n${formatSessions(status.sessions)}`);
    return 0;
  },
  async sessions(argv, io) {
    const a = parseArgs(argv, { flags: ["--json"] });
    const list = await withDaemon(io, undefined, (c) => c.request<SessionSummary[]>("sessions"));
    io.stdout(a.flags.has("--json") ? `${JSON.stringify(list, null, 2)}\n` : formatSessions(list));
    return 0;
  },
  async session(argv, io) {
    const a = parseArgs(argv, { flags: ["--sleep"], options: SESSION });
    if (a.positionals[0] !== "end") throw new UsageError("usage: perch session end [--session <name>] [--sleep]");
    const session = a.options.get("--session");
    await withDaemon(io, session, (c) => c.request("end", { onEnd: a.flags.has("--sleep") ? "sleep" : "close" }));
    return 0;
  },
  /** Brings a session's tabs forward; agterm and agmux run this for their own sessions. */
  async focus(argv, io) {
    const a = parseArgs(argv, { options: [...SESSION, "--client"] });
    const session = a.options.get("--session");
    // A mark in agterm or agmux can outlive perchd; clicking it must not start a browser.
    await withDaemon({ ...io, autostart: false }, undefined, (c) => c.request("focus", session ? { session } : {}), a.options.get("--client"));
    return 0;
  },
  async clients(argv, io) {
    const [action = "list", name, mode] = parseArgs(argv).positionals;
    const call: Record<string, [string, Record<string, unknown>]> = {
      list: ["clients.list", {}],
      revoke: ["clients.revoke", { name }],
      allow: ["clients.allow", { name }],
      mode: ["clients.mode", { name, mode }],
    };
    const picked = call[action];
    if (!picked || (action !== "list" && !name) || (action === "mode" && !mode)) throw new UsageError("usage: perch clients [list | revoke <name> | allow <name> | mode <name> ask|guard|skip]");
    if (action === "allow" || action === "mode") io.stderr("If this lets the client do more, Perch asks you to confirm in a dialog.\n");
    io.stdout(formatClients(await withDaemon(io, undefined, (c) => c.request<ClientRecord[]>(...picked), "cli")));
    return 0;
  },
};

/** One REPL run: its output on stdout, an error on stderr. */
async function replRun(io: CliIO, session: string | undefined, code: string): Promise<number> {
  if (!code.trim()) throw new UsageError('usage: perch repl "<javascript>"   (or run perch repl alone for a prompt)');
  const result = await withDaemon(io, session, (c) => c.request<ToolResult>("repl.run", { code }));
  (result.isError ? io.stderr : io.stdout)(`${result.content}\n`);
  return result.isError ? 1 : 0;
}

/**
 * The interactive prompt: each entry runs when its brackets close. Variables stay between entries
 * (and between commands, for half an hour). .reset clears them; .exit or Ctrl-D leaves.
 */
async function replLoop(io: CliIO, session: string | undefined): Promise<number> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  io.stderr("Perch REPL: await openTab(url), snapshot(page), page.locator(ref).click(), log(...). .help for more, .exit to leave.\n");
  let buffer = "";
  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question(buffer ? "... " : "perch> ");
      } catch {
        break;
      }
      if (!buffer && line.trim() === ".exit") break;
      if (!buffer && line.trim() === ".help") {
        io.stderr(`${REPL_HELP}\n`);
        continue;
      }
      if (!buffer && line.trim() === ".reset") {
        await withDaemon(io, session, (c) => c.request("repl.reset"));
        io.stderr("Cleared.\n");
        continue;
      }
      buffer += `${line}\n`;
      if (!balanced(buffer)) continue;
      const code = buffer;
      buffer = "";
      if (!code.trim()) continue;
      await replRun(io, session, code).catch((e: Error) => io.stderr(`${e.message}\n`));
    }
  } finally {
    rl.close();
  }
  return 0;
}

const REPL_HELP = `  page                     the tab you work in (after openTab or attachBrowserTab)
  await openTab(url)       open a page in a new tab of yours; returns it and sets page
  await listBrowserTabs()  every tab: { targetId, title, url, owner, current }
  await attachBrowserTab(id)   work in a tab from the list
  await snapshot(page)     { tree, diff }: the page as text with refs like e12, and what changed
  page.locator("e12").click() / .fill(text) / .press(key) / .selectOption(v) / .hover()
  await page.goto(url) · page.goBack() · page.evaluate(fn, arg) · page.title() · page.url()
  page.keyboard.press(key) · page.keyboard.type(text)
  sleep(seconds) · log(...) · console.log(...)
  Variables stay between runs; declaring a name again replaces it.`;

/** Whether brackets and quotes in the entry are closed, so it can run. */
function balanced(code: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return depth <= 0 && quote === null;
}
