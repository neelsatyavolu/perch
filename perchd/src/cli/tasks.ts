/**
 * Tasks from the terminal, the way Aside's CLI runs them: `perch exec` starts a task in Perch (a
 * chat you can open and watch), streams its steps to stderr and prints only the answer on stdout;
 * `perch session …` lists, inspects, resumes, steers, queues, stops and deletes those tasks.
 * Plus read-only memory and skills, and `perch script`.
 */

import type { TaskView } from "../app/tasks";
import { parseArgs, UsageError } from "./args";
import type { DaemonClient } from "./client";
import { DaemonNotRunning } from "./client";
import { openDaemon, type CliIO } from "./io";

type Command = (argv: string[], io: CliIO) => Promise<number>;

const POLL_MS = 500;
const EXEC_FLAGS = ["--json", "--standalone"];
const EXEC_OPTIONS = ["-m", "--model", "--effort", "--thinking", "--permission", "--timeout", "--log-dump", "-p", "--provider", "--session"];

/** "30s", "5m", "1h", or a number of seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(text.trim());
  if (!m) throw new UsageError(`--timeout takes a duration such as 30s, 5m or 1h, not "${text}"`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as Record<string, number>)[unit]!;
}

async function connected<T>(io: CliIO, run: (c: DaemonClient) => Promise<T>): Promise<T> {
  // Tasks live in the Perch app: starting a bare perchd here would only say it is missing.
  const c = await openDaemon({ ...io, autostart: false });
  try {
    return await run(c);
  } finally {
    c.close();
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const FINISHED = new Set(["done", "failed", "stopped"]);

/**
 * Follows a task until it finishes or `timeoutMs` passes: steps and approval waits to stderr, the
 * answer to stdout (or everything as JSON). 0 when it finished with an answer.
 */
async function follow(io: CliIO, c: DaemonClient, first: TaskView, opts: { json: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<number> {
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
  let shown = 0;
  let waiting: string | null = null;
  let view = first;
  io.stderr(`Session ${shortId(view.id)} · ${view.title}\n`);
  for (;;) {
    for (const step of view.steps.slice(shown)) io.stderr(`  · ${step}\n`);
    shown = Math.max(shown, view.steps.length);
    if (view.waitingFor !== waiting) {
      waiting = view.waitingFor;
      if (waiting) io.stderr(`  ⏸ Waiting for you in Perch: ${waiting}\n`);
    }
    if (FINISHED.has(view.status)) break;
    if (opts.signal?.aborted) {
      await c.request("task.stop", { id: view.id }).catch(() => undefined);
      io.stderr(`Stopped session ${shortId(view.id)}.\n`);
      return 130;
    }
    if (Date.now() > deadline) {
      io.stderr(`Stopped waiting; the task keeps running. Follow it with: perch session resume ${shortId(view.id)}\n`);
      if (opts.json) io.stdout(`${JSON.stringify({ session: view.id, title: view.title, status: view.status, answer: view.answer, steps: view.steps }, null, 2)}\n`);
      return 1;
    }
    await Bun.sleep(POLL_MS);
    view = await c.request<TaskView>("task.get", { id: view.id });
  }
  if (opts.json) io.stdout(`${JSON.stringify({ session: view.id, title: view.title, status: view.status, answer: view.answer, steps: view.steps }, null, 2)}\n`);
  else if (view.answer) io.stdout(`${view.answer.trim()}\n`);
  if (view.status !== "done") io.stderr(`Session ${shortId(view.id)} ${view.status}.\n`);
  return view.status === "done" && view.answer ? 0 : 1;
}

/** Ctrl-C stops the task, as it would stop any command; the signal tells `follow` to do so. */
function interrupts(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onInt = () => controller.abort();
  process.once("SIGINT", onInt);
  return { signal: controller.signal, done: () => process.off("SIGINT", onInt) };
}

export const taskCommands: Record<string, Command> = {
  async exec(argv, io) {
    const a = parseArgs(argv, { flags: EXEC_FLAGS, options: EXEC_OPTIONS });
    const task = a.positionals.join(" ").trim();
    if (!task) throw new UsageError('usage: perch exec [-m model] [--effort low|medium|high] [--permission ask|guard|full-access] [--timeout 5m] [--json] "<task>"');
    const provider = a.options.get("-p") ?? a.options.get("--provider");
    const named = a.options.get("-m") ?? a.options.get("--model");
    const model = named && provider && !named.includes("/") ? `${provider}/${named}` : named;
    const effort = a.options.get("--effort") ?? a.options.get("--thinking");
    const timeoutMs = a.options.has("--timeout") ? parseDuration(a.options.get("--timeout")!) : undefined;
    // Benchmark runners (`--log-dump`) and `--standalone` run one agent outside the app, as before.
    if (a.flags.has("--standalone") || a.options.has("--log-dump")) return standalone(argv);
    let first: TaskView;
    let c: DaemonClient;
    try {
      c = await openDaemon({ ...io, autostart: false });
    } catch (error) {
      if (!(error instanceof DaemonNotRunning)) throw error;
      io.stderr("Perch is not running, so this task runs on its own, outside Perch's chats. Open Perch to keep tasks as sessions.\n");
      return standalone(argv);
    }
    try {
      try {
        first = await c.request<TaskView>("task.start", { task, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(a.options.has("--permission") ? { mode: a.options.get("--permission") } : {}) });
      } catch (error) {
        if (!/need the Perch app/.test((error as Error).message)) throw error;
        io.stderr("perchd runs without the Perch app, so this task runs on its own.\n");
        return standalone(argv);
      }
      const stop = interrupts();
      try {
        return await follow(io, c, first, { json: a.flags.has("--json"), timeoutMs, signal: stop.signal });
      } finally {
        stop.done();
      }
    } finally {
      c.close();
    }
  },

  async session(argv, io) {
    const [action, ...rest] = argv;
    const handler = action ? SESSION_ACTIONS[action] : undefined;
    if (!handler) throw new UsageError(SESSION_USAGE);
    return handler(rest, io);
  },

  async memory(argv, io) {
    const [action, ...rest] = argv;
    if (action === "search") {
      const a = parseArgs(rest, { flags: ["--json"], options: ["--limit"] });
      const query = a.positionals.join(" ").trim();
      if (!query) throw new UsageError('usage: perch memory search "<query>" [--limit n] [--json]');
      const limit = a.options.has("--limit") ? Number(a.options.get("--limit")) : 10;
      const hits = await connected(io, (c) => c.request<{ path: string; title: string; snippet: string; score: number }[]>("memory.search", { query, limit }));
      if (a.flags.has("--json")) io.stdout(`${JSON.stringify(hits, null, 2)}\n`);
      else io.stdout(hits.length ? hits.map((h) => `${h.path}  ${h.title}\n  ${h.snippet.replace(/\s+/g, " ").trim()}\n`).join("") : "Nothing in memory matches.\n");
      return 0;
    }
    if (action === "list") {
      const a = parseArgs(rest, { flags: ["--json"] });
      const pages = await connected(io, (c) => c.request<{ path: string; title: string; facts: number; updated: string }[]>("memory.list"));
      if (a.flags.has("--json")) io.stdout(`${JSON.stringify(pages, null, 2)}\n`);
      else io.stdout(pages.length ? pages.map((p) => `${p.path}  ${p.title} (${p.facts} ${p.facts === 1 ? "fact" : "facts"})\n`).join("") : "Memory is empty.\n");
      return 0;
    }
    if (action === "show") {
      const a = parseArgs(rest, { flags: ["--json"] });
      const [path] = a.positionals;
      if (!path) throw new UsageError("usage: perch memory show <path>   (for example USER.md; see perch memory list)");
      const page = await connected(io, (c) => c.request<{ path: string; title: string; current: { text: string }[]; history: { text: string }[] }>("memory.show", { path }));
      if (a.flags.has("--json")) io.stdout(`${JSON.stringify(page, null, 2)}\n`);
      else {
        const history = page.history.length ? `\n## Earlier\n${page.history.map((f) => `- ${f.text}`).join("\n")}\n` : "";
        io.stdout(`# ${page.title}\n${page.path}\n\n${page.current.map((f) => `- ${f.text}`).join("\n")}\n${history}`);
      }
      return 0;
    }
    throw new UsageError('usage: perch memory search "<query>" | list | show <path>   (read only; Perch keeps memory encrypted, so there is no folder to open)');
  },

  async skills(argv, io) {
    const [action, ...rest] = argv;
    if (action === "list" || action === undefined) {
      const list = await connected(io, (c) => c.request<{ name: string; description: string; origin: string }[]>("skills.list"));
      io.stdout(list.length ? list.map((s) => `${s.name.padEnd(16)} ${s.description}${s.origin === "mine" ? " (yours)" : ""}\n`).join("") : "No skills.\n");
      if (list.length) io.stderr("Read one with: perch skills show <name>\n");
      return 0;
    }
    if (action === "show") {
      const [name, file] = rest;
      if (!name) throw new UsageError("usage: perch skills show <name> [file]");
      io.stdout(`${await connected(io, (c) => c.request<string>("skills.show", { name, ...(file ? { file } : {}) }))}\n`);
      return 0;
    }
    throw new UsageError("usage: perch skills list | show <name> [file]");
  },
};

const SESSION_USAGE = `usage: perch session <command>

  list [--json]                     tasks this client started, newest first
  inspect <id> [--json]             a task's status, steps and latest answer
  resume <id> ["<follow-up>"]       continue a task (or wait for it and print its answer)
  steer <id> "<message>"            interrupt the current step with a new instruction
  queue <id> "<message>"            run this after the current step finishes
  stop <id>                         stop a running task
  delete <id> --yes                 delete a task and its chat; cannot be undone
  end [--sleep] [--session <name>]  close (or put to sleep) this terminal's tabs

Ids can be shortened to their first 8 characters, as list prints them.`;

const SESSION_ACTIONS: Record<string, Command> = {
  async list(argv, io) {
    const a = parseArgs(argv, { flags: ["--json"] });
    const list = await connected(io, (c) => c.request<TaskView[]>("task.list"));
    if (a.flags.has("--json")) io.stdout(`${JSON.stringify(list, null, 2)}\n`);
    else io.stdout(list.length ? list.map((t) => `${shortId(t.id)}  ${t.status.padEnd(8)} ${t.title}  (${ago(t.updatedAt)})\n`).join("") : "No tasks yet. Start one with: perch exec \"<task>\"\n");
    return 0;
  },
  async inspect(argv, io) {
    const a = parseArgs(argv, { flags: ["--json"] });
    const [id] = a.positionals;
    if (!id) throw new UsageError("usage: perch session inspect <id> [--json]");
    const t = await connected(io, (c) => c.request<TaskView>("task.get", { id }));
    if (a.flags.has("--json")) io.stdout(`${JSON.stringify(t, null, 2)}\n`);
    else {
      const lines = [`${t.title}`, `Session ${t.id}`, `Status: ${t.status}${t.waitingFor ? ` (waiting for you in Perch: ${t.waitingFor})` : ""}`, `Model: ${t.model}, ${t.effort} effort, ${t.mode} mode · ${t.turns} ${t.turns === 1 ? "turn" : "turns"} · updated ${ago(t.updatedAt)}`];
      if (t.steps.length) lines.push("", "Steps:", ...t.steps.map((s) => `  · ${s}`));
      if (t.answer) lines.push("", t.answer.trim());
      io.stdout(`${lines.join("\n")}\n`);
    }
    return 0;
  },
  async resume(argv, io) {
    const a = parseArgs(argv, { flags: ["--json"], options: ["--timeout"] });
    const [id, ...words] = a.positionals;
    if (!id) throw new UsageError('usage: perch session resume <id> ["<follow-up>"] [--timeout 5m] [--json]');
    const text = words.join(" ").trim();
    const timeoutMs = a.options.has("--timeout") ? parseDuration(a.options.get("--timeout")!) : undefined;
    return connected(io, async (c) => {
      const before = await c.request<TaskView>("task.get", { id });
      const first = text ? await c.request<TaskView>("task.send", { id: before.id, text }) : before;
      const stop = interrupts();
      try {
        return await follow(io, c, first, { json: a.flags.has("--json"), timeoutMs, signal: stop.signal });
      } finally {
        stop.done();
      }
    });
  },
  async steer(argv, io) {
    const [id, ...words] = parseArgs(argv).positionals;
    const text = words.join(" ").trim();
    if (!id || !text) throw new UsageError('usage: perch session steer <id> "<message>"');
    const t = await connected(io, (c) => c.request<TaskView>("task.steer", { id, text }));
    io.stdout(`Steered session ${shortId(t.id)}. Follow it with: perch session resume ${shortId(t.id)}\n`);
    return 0;
  },
  async queue(argv, io) {
    const [id, ...words] = parseArgs(argv).positionals;
    const text = words.join(" ").trim();
    if (!id || !text) throw new UsageError('usage: perch session queue <id> "<message>"');
    const r = await connected(io, (c) => c.request<{ queued: number }>("task.queue", { id, text }));
    io.stdout(`Queued for session ${id} (${r.queued} waiting). It runs when the current step finishes.\n`);
    return 0;
  },
  async stop(argv, io) {
    const [id] = parseArgs(argv).positionals;
    if (!id) throw new UsageError("usage: perch session stop <id>");
    const r = await connected(io, (c) => c.request<{ stopped: boolean }>("task.stop", { id }));
    io.stdout(r.stopped ? `Stopped session ${id}.\n` : `Session ${id} was not running.\n`);
    return 0;
  },
  async delete(argv, io) {
    const a = parseArgs(argv, { flags: ["--yes"] });
    const [id] = a.positionals;
    if (!id) throw new UsageError("usage: perch session delete <id> --yes");
    if (!a.flags.has("--yes")) throw new UsageError("Deleting a session removes its chat from Perch for good. Add --yes to confirm.");
    await connected(io, (c) => c.request("task.delete", { id }));
    io.stdout(`Deleted session ${id}.\n`);
    return 0;
  },
};

async function standalone(argv: string[]): Promise<number> {
  const { main } = await import("../exec");
  return main(argv);
}
