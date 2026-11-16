/**
 * The prompt an outside agent is working on, so its chat in Perch can show what it was asked
 * rather than only "Codex · perch is working in Perch". Read from local files only, on each tool
 * call: PERCH_TASK when a script sets it, else the agent's own session transcript on this Mac
 * (Claude Code's projects/<folder>/<session>.jsonl, Codex's sessions/…/rollout-*.jsonl). Only the
 * end of a transcript is read, only the latest prompt is taken, and it goes to perchd alone.
 */

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanPrompt as tidy } from "../daemon/protocol";

type Env = Record<string, string | undefined>;

export type PromptLookup = {
  env: Env;
  cwd: string;
  /** The process that started this one: the agent itself for `perch mcp`, a shell for a `perch` command. */
  parent: number;
  /** The client or agent name, so a Codex session is looked for only for Codex. */
  agent?: string;
};

/** How much of the end of a transcript is read. */
const TAIL_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 32 * 1024;
/** Codex rollouts older than this are not the session making calls now. */
const CODEX_RECENT_MS = 24 * 60 * 60_000;
const CODEX_MAX_FILES = 40;

/** The latest prompt, or undefined when there is none to be found. */
export function agentPrompt(lookup: PromptLookup): string | undefined {
  const explicit = tidy(lookup.env.PERCH_TASK);
  if (explicit) return explicit;
  try {
    // A Claude Code process that started this one is the agent for sure. CLAUDE_PID, CODEX_THREAD_ID
    // and the like can be inherited from an agent further up (Codex started by Claude Code, or the
    // other way round), and one agent's prompt is never shown as another's.
    const config = claudeConfig(lookup.env);
    const parent = config ? claudeSession(config, lookup.parent) : undefined;
    if (parent) return claudePrompt(lookup, parent);
    const codex = /codex/i.test(lookup.agent ?? "") || Boolean(lookup.env.CODEX_THREAD_ID);
    return codex ? codexPrompt(lookup) : claudePrompt(lookup);
  } catch {
    return undefined; // A transcript that moved or changed shape is not worth failing a tool call.
  }
}

// Claude Code -------------------------------------------------------------------------------

function claudeConfig(env: Env): string {
  return env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, ".claude") : "");
}

/** `live` is the session found from the parent process; else CLAUDE_PID's, else CLAUDE_CODE_SESSION_ID. */
function claudePrompt({ env, cwd }: PromptLookup, live?: { id: string; cwd?: string }): string | undefined {
  const config = claudeConfig(env);
  if (!config) return undefined;
  live ??= claudeSession(config, Number(env.CLAUDE_PID));
  const id = live?.id ?? env.CLAUDE_CODE_SESSION_ID;
  if (!id || !/^[A-Za-z0-9-]{1,80}$/.test(id)) return undefined;
  const file = claudeTranscript(config, live?.cwd ?? cwd, id);
  return file ? lastClaudePrompt(readTail(file)) : undefined;
}

/** The session a Claude Code process is in now: it rewrites sessions/<pid>.json on /clear and resume. */
function claudeSession(config: string, pid: number): { id: string; cwd?: string } | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const file = join(config, "sessions", `${pid}.json`);
  if (!existsSync(file)) return undefined;
  const info = JSON.parse(readFileSync(file, "utf8")) as { sessionId?: unknown; cwd?: unknown };
  return typeof info.sessionId === "string" ? { id: info.sessionId, ...(typeof info.cwd === "string" ? { cwd: info.cwd } : {}) } : undefined;
}

/** projects/<the folder with every other character as "-">/<id>.jsonl, else any project folder holding it. */
function claudeTranscript(config: string, cwd: string, id: string): string | undefined {
  const projects = join(config, "projects");
  const direct = join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  if (existsSync(direct)) return direct;
  if (!existsSync(projects)) return undefined;
  return readdirSync(projects).map((dir) => join(projects, dir, `${id}.jsonl`)).find((f) => existsSync(f));
}

/** The last prompt a person typed in a Claude Code transcript; its `last-prompt` note (cut short) when that is all the tail holds. */
export function lastClaudePrompt(tail: string): string | undefined {
  let noted: string | undefined;
  for (const entry of entriesFromEnd(tail)) {
    if (entry.type === "last-prompt" && noted === undefined) noted = tidy(entry.lastPrompt);
    if (entry.type !== "user" || entry.isMeta || entry.isSidechain || entry.isCompactSummary) continue;
    if (entry.origin !== undefined && entry.origin?.kind !== "human") continue;
    const text = typedText(messageText(entry.message?.content, "text"));
    if (text) return tidy(text);
  }
  return noted;
}

/**
 * What a person typed, from a Claude Code user message: pasted text unwrapped, a slash command as
 * "/name args". Tool results (no text), "<task-notification>" and the like, and the
 * "[Request interrupted by user]" line give "".
 */
function typedText(text: string): string {
  const command = /^<command-message>[\s\S]*?<command-name>([^<]*)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/.exec(text);
  if (command) return `${command[1]!.trim()} ${command[2]?.trim() ?? ""}`.trim();
  const unwrapped = text.replace(/<\/?pasted_content\b[^>]*>/g, "").trim();
  if (unwrapped.startsWith("<") || unwrapped.startsWith("[Request interrupted")) return "";
  return unwrapped;
}

// Codex -------------------------------------------------------------------------------------

function codexPrompt({ env, cwd }: PromptLookup): string | undefined {
  const home = env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : "");
  if (!home) return undefined;
  const thread = env.CODEX_THREAD_ID && /^[A-Za-z0-9-]{1,80}$/.test(env.CODEX_THREAD_ID) ? env.CODEX_THREAD_ID : undefined;
  const file = codexRollout(join(home, "sessions"), cwd, thread);
  return file ? lastCodexPrompt(readTail(file)) : undefined;
}

/** The rollout for a thread id, else the most recently written top-level rollout started in `cwd`. */
function codexRollout(sessions: string, cwd: string, thread: string | undefined): string | undefined {
  const files = recentRollouts(sessions);
  if (thread) return files.find((f) => f.endsWith(`-${thread}.jsonl`));
  const now = Date.now();
  for (const file of files.slice(0, CODEX_MAX_FILES)) {
    if (now - statSync(file).mtimeMs > CODEX_RECENT_MS) break;
    const meta = rolloutMeta(readHead(file));
    if (meta.cwd === cwd && !meta.subagent) return file;
  }
  return undefined;
}

/** Rollouts in the newest three day folders (sessions/YYYY/MM/DD), newest first. */
function recentRollouts(sessions: string): string[] {
  if (!existsSync(sessions)) return [];
  const days: string[] = [];
  const newest = (dir: string) => readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse().map((n) => join(dir, n));
  for (const year of newest(sessions)) {
    for (const month of newest(year)) {
      days.push(...newest(month));
      if (days.length >= 3) break;
    }
    if (days.length >= 3) break;
  }
  return days
    .slice(0, 3)
    .flatMap((day) => readdirSync(day).filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl")).map((n) => join(day, n)))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.file);
}

/** The folder and kind of a rollout from its first line, which can be too long to read whole. */
export function rolloutMeta(head: string): { cwd?: string; subagent: boolean } {
  const cwd = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head)?.[1];
  return { ...(cwd ? { cwd: JSON.parse(cwd) as string } : {}), subagent: head.includes('"source":{"subagent"') };
}

/** The last prompt in a Codex rollout: its `user_message` event, else the last user message that isn't injected context. */
export function lastCodexPrompt(tail: string): string | undefined {
  let message: string | undefined;
  for (const entry of entriesFromEnd(tail)) {
    const p = entry.payload;
    if (entry.type === "event_msg" && p?.type === "user_message") return tidy(p.message);
    if (message === undefined && entry.type === "response_item" && p?.type === "message" && p.role === "user") {
      const text = messageText(p.content, "input_text");
      // "<environment_context>", "# AGENTS.md instructions" and the like are added by Codex.
      if (text && !text.startsWith("<") && !text.startsWith("# AGENTS.md")) message = tidy(text);
    }
  }
  return message;
}

// Files -------------------------------------------------------------------------------------

/** JSON lines from the end back; the first line of a tail is usually cut, and is skipped when it does not parse. */
function* entriesFromEnd(tail: string): Generator<any> {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A line cut by the tail, or one still being written.
    }
  }
}

/** A message's text: the string itself, or its text blocks joined. */
function messageText(content: unknown, blockType: string): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === blockType && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

function readTail(file: string, bytes = TAIL_BYTES): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readHead(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
