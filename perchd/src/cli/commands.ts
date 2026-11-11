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
  async repl(argv, io) {
    const a = parseArgs(argv, { options: SESSION });
    const code = one(a.positionals, 'perch repl "<javascript>"').join(" ");
    return tool(io, a.options.get("--session"), "repl", { code });
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
