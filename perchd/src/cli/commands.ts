/** One-shot browser and session commands: each connects, does one thing, and disconnects. */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ClientRecord } from "../daemon/clients";
import type { SessionSummary } from "../daemon/sessions";
import { parseArgs, UsageError } from "./args";
import { DaemonNotRunning, type DaemonClient } from "./client";
import { agentPrompt } from "./agent-prompt";
import { openDaemon, type CliIO } from "./io";
import { parseDuration } from "./tasks";
import { formatTranscript, formatTranscriptList } from "./transcript-format";
import type { TranscriptRecord } from "../agent/debug-transcript";

type ToolResult = { content: string; image?: string; isError?: boolean };
type Status = { client: string; mode: string; session: string; label: string; pid: number; socket: string; sessions: SessionSummary[] };

const SESSION = ["--session"];

async function withDaemon<T>(io: CliIO, session: string | undefined, run: (c: DaemonClient) => Promise<T>, client?: string): Promise<T> {
  // A session named with --session is labelled by that name, so two of them in one folder differ.
  const c = await openDaemon(io, { session, client, ...(session ? { title: session } : {}) });
  try {
    return await run(c);
  } finally {
    c.close();
  }
}

/** Runs one tool in the terminal's session and prints its text; 1 when the tool failed. */
async function tool(io: CliIO, session: string | undefined, name: string, args: Record<string, unknown>): Promise<number> {
  // An agent running `perch` in its shell: what its user asked it, for its chat in Perch.
  const prompt = agentPrompt({ env: io.env, cwd: io.cwd, parent: process.ppid, agent: io.env.PERCH_CLIENT });
  const result = await withDaemon(io, session, (c) => c.request<ToolResult>("call", { name, args, ...(prompt ? { prompt } : {}) }));
  (result.isError ? io.stderr : io.stdout)(`${result.content}\n`);
  return result.isError ? 1 : 0;
}

/** The positional arguments, at least `count` of them and at most `max` (extra words are a mistake, not dropped). */
function one(positionals: string[], usage: string, count = 1, max = Infinity): string[] {
  if (positionals.length < count) throw new UsageError(`usage: ${usage}`);
  if (positionals.length > max) throw new UsageError(`perch: unexpected "${positionals.slice(max).join(" ").slice(0, 60)}"\nusage: ${usage}`);
  return positionals;
}

export const browserCommands: Record<string, (argv: string[], io: CliIO) => Promise<number>> = {
  async open(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [url] = one(a.positionals, "perch open <url> [--session <name>]", 1, 1);
    return tool(io, a.options.get("--session"), "open_tab", { url });
  },
  async snapshot(argv, io) {
    const a = parseArgs(argv, { flags: ["--full"], options: SESSION });
    return tool(io, a.options.get("--session"), "snapshot", { full: a.flags.has("--full") });
  },
  async click(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [ref] = one(a.positionals, "perch click <ref>", 1, 1);
    return tool(io, a.options.get("--session"), "click", { ref });
  },
  async type(argv, io) {
    const a = parseArgs(argv, { flags: ["--submit"], options: SESSION });
    const [ref, ...text] = one(a.positionals, "perch type <ref> <text> [--submit]", 2);
    return tool(io, a.options.get("--session"), "type", { ref, text: text.join(" "), submit: a.flags.has("--submit") });
  },
  async press(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [key] = one(a.positionals, "perch press <key>", 1, 1);
    return tool(io, a.options.get("--session"), "press", { key });
  },
  async script(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const code = one(a.positionals, 'perch script "<javascript calling navigate(), snapshot(), click(), js() …>"').join(" ");
    return tool(io, a.options.get("--session"), "script", { code });
  },
  async navigate(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [url] = one(a.positionals, "perch navigate <url>", 1, 1);
    return tool(io, a.options.get("--session"), "navigate", { url });
  },
  async select(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [ref, ...value] = one(a.positionals, "perch select <ref> <option>", 2);
    return tool(io, a.options.get("--session"), "select", { ref, value: value.join(" ") });
  },
  /** Scrolls the page: down or up a screenful, or by a number of pixels (negative is up). */
  async scroll(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [how = "down"] = one(a.positionals.length ? a.positionals : ["down"], "perch scroll [down | up | <pixels>]", 1, 1);
    const dy = how === "down" ? 800 : how === "up" ? -800 : Number(how);
    if (!Number.isFinite(dy) || dy === 0) throw new UsageError("usage: perch scroll [down | up | <pixels>]");
    return tool(io, a.options.get("--session"), "scroll", { dy });
  },
  async back(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    return tool(io, a.options.get("--session"), "back", {});
  },
  /** JavaScript on a read-only copy of the page, with its JSON result (it can read, not change, the page). */
  async eval(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const code = one(a.positionals, 'perch eval "<javascript>"   (runs on a read-only copy of the page)').join(" ");
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
    const named = a.options.get("-o") ?? a.options.get("--output");
    // Screenshots are JPEG: a .png name would hold JPEG data. Checked before taking one.
    if (named && !/\.jpe?g$/i.test(named)) throw new UsageError(`perch: screenshots are JPEG; name the file .jpg (got "${named.slice(-40)}")`);
    const result = await withDaemon(io, a.options.get("--session"), (c) => c.request<ToolResult>("call", { name: "screenshot", args: {} }));
    if (result.isError || !result.image) {
      io.stderr(`${result.content}\n`);
      return 1;
    }
    const file = resolve(io.cwd, named ?? `perch-screenshot-${Date.now()}.jpg`);
    try {
      writeFileSync(file, Buffer.from(result.image, "base64"), { mode: 0o600 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      io.stderr(`perch: can't save ${file}: ${code === "ENOENT" ? "that folder doesn't exist" : code === "EISDIR" ? "that's a folder; give a file name" : code === "EACCES" ? "no permission to write there" : (error as Error).message}\n`);
      return 1;
    }
    io.stdout(`Saved ${file}\n`);
    return 0;
  },
  async find(argv, io) {
    const a = parseArgs(argv, { flags: ["--contains"], options: [...SESSION, "--role"] });
    const name = one(a.positionals, 'perch find "<name>" [--role button] [--contains]').join(" ");
    return tool(io, a.options.get("--session"), "find", { name, role: a.options.get("--role") ?? "", contains: a.flags.has("--contains") });
  },
  async hover(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [ref] = one(a.positionals, "perch hover <ref>", 1, 1);
    return tool(io, a.options.get("--session"), "hover", { ref });
  },
  /** Waits for text on the page (up to --timeout, 10s by default), or for --seconds. */
  async wait(argv, io) {
    const a = parseArgs(argv, { options: [...SESSION, "--timeout", "--seconds"] });
    const usage = 'perch wait "<text>" [--timeout 10s] | perch wait --seconds <n>';
    if (a.options.has("--seconds")) {
      one(a.positionals, usage, 0, 0);
      const seconds = Number(a.options.get("--seconds"));
      if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError(`perch: --seconds takes a number of seconds, like 3\nusage: ${usage}`);
      return tool(io, a.options.get("--session"), "wait_for", { seconds });
    }
    const text = one(a.positionals, usage).join(" ");
    const timeout = a.options.get("--timeout");
    return tool(io, a.options.get("--session"), "wait_for", { text, ...(timeout ? { timeout_s: parseDuration(timeout) / 1000 } : {}) });
  },
  async switch(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const [id] = one(a.positionals, "perch switch <tab id>   (ids from perch tabs)", 1, 1);
    return tool(io, a.options.get("--session"), "switch_tab", { id });
  },
  async downloads(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    one(a.positionals, "perch downloads", 0, 0);
    return tool(io, a.options.get("--session"), "downloads", {});
  },
  /** A link's document (read_document), or a file from perch downloads when given a path (read_download). */
  async read(argv, io) {
    const a = parseArgs(argv, { options: [...SESSION, "--from"] });
    const usage = "perch read <url | path from perch downloads> [--from n]";
    const target = one(a.positionals, usage, 1, 1)[0]!;
    const from = a.options.has("--from") ? Number(a.options.get("--from")) : 0;
    if (!Number.isInteger(from) || from < 0) throw new UsageError(`perch: --from takes the character to start at, as the last part's note says\nusage: ${usage}`);
    // perchd runs in its own folder, so a relative path is made absolute here, from this terminal's.
    const isPath = /^(\/|~\/|\.\.?\/|file:\/\/)/.test(target);
    const path = target.startsWith("~/") ? `${io.env.HOME ?? homedir()}${target.slice(1)}` : target.startsWith("file://") ? target : resolve(io.cwd, target);
    return isPath ? tool(io, a.options.get("--session"), "read_download", { path, from }) : tool(io, a.options.get("--session"), "read_document", { url: target, from });
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
    let status: Status;
    try {
      status = await withDaemon({ ...io, autostart: false }, undefined, (c) => c.request<Status>("status"));
    } catch (error) {
      // Scripts that ask for JSON get JSON either way; the exit code (3) still says it's not running.
      if (!(error instanceof DaemonNotRunning) || !a.flags.has("--json")) throw error;
      io.stdout(`${JSON.stringify({ running: false })}\n`);
      return 3;
    }
    if (a.flags.has("--json")) io.stdout(`${JSON.stringify({ running: true, ...status }, null, 2)}\n`);
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
    const sleep = a.flags.has("--sleep");
    const { tabs } = await withDaemon(io, session, (c) => c.request<{ tabs?: number }>("end", { onEnd: sleep ? "sleep" : "close" }));
    io.stdout(!tabs ? "Ended the session; it had no tabs.\n" : sleep ? `Put ${plural(tabs, "tab")} to sleep. perch focus wakes them.\n` : `Ended the session and closed ${plural(tabs, "tab")}.\n`);
    return 0;
  },
  /** Brings a session's tabs forward; agterm and agmux run this for their own sessions. */
  async focus(argv, io) {
    const a = parseArgs(argv, { options: [...SESSION, "--client"] });
    const session = a.options.get("--session");
    // A mark in agterm or agmux can outlive perchd; clicking it must not start a browser.
    const { label } = await withDaemon({ ...io, autostart: false }, undefined, (c) => c.request<{ label?: string }>("focus", session ? { session } : {}), a.options.get("--client"));
    io.stdout(label ? `Showing ${label}.\n` : "Done.\n");
    return 0;
  },
  /** A chat's debug transcript (the newest chat without --chat), for working out what went wrong. */
  async transcript(argv, io) {
    const a = parseArgs(argv, { flags: ["--json", "--list"], options: ["--chat"] });
    if (a.positionals.length) throw new UsageError("usage: perch transcript [--chat <id>] [--json] | --list");
    if (a.flags.has("--list")) {
      const chats = await withDaemon(io, undefined, (c) => c.request<{ id: string; title: string; updatedAt: string }[]>("transcript.list", {}), "cli");
      io.stdout(a.flags.has("--json") ? `${JSON.stringify(chats, null, 2)}\n` : formatTranscriptList(chats));
      return 0;
    }
    const chat = a.options.get("--chat");
    const t = await withDaemon(io, undefined, (c) => c.request<{ chatId: string; title: string; events: TranscriptRecord[] }>("transcript.show", chat ? { chat } : {}), "cli");
    io.stdout(a.flags.has("--json") ? t.events.map((e) => `${JSON.stringify(e)}\n`).join("") : formatTranscript(t.title, t.chatId, t.events));
    return 0;
  },
  async clients(argv, io) {
    const parsed = parseArgs(argv, { flags: ["--json"] });
    const [action = "list", name, mode] = parsed.positionals;
    const call: Record<string, [string, Record<string, unknown>]> = {
      list: ["clients.list", {}],
      revoke: ["clients.revoke", { name }],
      allow: ["clients.allow", { name }],
      mode: ["clients.mode", { name, mode }],
    };
    const picked = call[action];
    if (!picked || (action !== "list" && !name) || (action === "mode" && !mode)) throw new UsageError("usage: perch clients [list | revoke <name> | allow <name> | mode <name> ask|guard|skip]");
    if (action === "allow" || action === "mode") io.stderr("If this lets the client do more, Perch asks you to confirm in a dialog.\n");
    const list = await withDaemon(io, undefined, (c) => c.request<ClientRecord[]>(...picked), "cli");
    io.stdout(parsed.flags.has("--json") ? `${JSON.stringify(list, null, 2)}\n` : formatClients(list));
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
