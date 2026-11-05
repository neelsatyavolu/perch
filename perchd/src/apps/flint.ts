/// <reference path="../text.d.ts" />
/**
 * Flint, the owner's mail app, as a tool for Perch's agent. It runs the `flint` command, which
 * talks to the running Flint app. Reading runs freely; changing mail follows the permission
 * mode; mail that leaves the Mac (send, rsvp, unsubscribe) asks in Perch in every mode and under
 * any site rule except "never", then waits for Flint's own approval as well.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Kind } from "../agent/permissions";
import type { ToolSpec } from "../models/types";
import skill from "../../skills/flint/SKILL.md" with { type: "text" };

export type AppToolResult = { content: string; isError?: boolean };

const READ = ["status", "list", "search", "read", "summarize", "receipts", "drafts", "folders", "invites", "queue"];
const CHANGE = ["draft", "reply", "forward", "mark-read", "unread", "pin", "unpin", "snooze", "unsnooze", "move", "undo", "cancel", "attachment"];
const RISKY = ["archive", "trash", "spam", "mute", "unmute", "draft-delete", "send", "rsvp", "unsubscribe"];
/** Commands that send mail to someone: Perch asks first even in Skip. */
const ALWAYS_ASK = new Set(["send", "rsvp", "unsubscribe"]);
const KINDS: Record<string, Kind> = Object.fromEntries([...READ.map((c) => [c, "read"]), ...CHANGE.map((c) => [c, "change"]), ...RISKY.map((c) => [c, "risky"])]);

/** Options that read local files or change who Flint thinks is acting. */
const BLOCKED_OPTIONS = /^--(as|body-file|attach)/;
const OUTPUT_LIMIT = 20_000;
const TIMEOUT_MS = 60_000;

export const FLINT_SPEC: ToolSpec = {
  name: "flint",
  description: `${skill.replace(/^---[\s\S]*?---\s*/, "").trim()}\n\nCall with command (one of: ${[...READ, ...CHANGE, ...RISKY].join(", ")}) and args, the words after it.`,
  parameters: {
    type: "object",
    properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
    required: ["command"],
    additionalProperties: false,
  },
};

/** The flint command: PERCH_FLINT_BIN, else where Flint's installer puts it. */
export function flintBinary(env: Record<string, string | undefined> = process.env): string | null {
  const candidates = [env.PERCH_FLINT_BIN, join(env.HOME || homedir(), ".local", "bin", "flint"), "/opt/homebrew/bin/flint", "/usr/local/bin/flint"];
  return candidates.find((c): c is string => Boolean(c && existsSync(c))) ?? null;
}

export function flintKind(args: Record<string, unknown>): Kind {
  return KINDS[String(args.command)] ?? "risky";
}

export function flintAlwaysAsks(args: Record<string, unknown>): boolean {
  return ALWAYS_ASK.has(String(args.command));
}

/** A plain error for a call that must not run, or null. */
export function checkFlint(args: Record<string, unknown>): string | null {
  const command = String(args.command ?? "");
  if (!Object.hasOwn(KINDS, command)) return `flint has no "${command}" command Perch can run; use one of: ${Object.keys(KINDS).join(", ")}`;
  const rest = (args.args as string[] | undefined) ?? [];
  const bad = rest.find((a) => BLOCKED_OPTIONS.test(a));
  if (bad) return `${bad.split("=")[0]} is not allowed from Perch`;
  return null;
}

export async function runFlint(args: Record<string, unknown>, env: Record<string, string | undefined> = process.env): Promise<AppToolResult> {
  const problem = checkFlint(args);
  if (problem) return { content: problem, isError: true };
  const bin = flintBinary(env);
  if (!bin) return { content: "Flint's command is not installed. Ask the user to click Settings → Agents → Install flint command in Flint.", isError: true };
  const child = Bun.spawn([bin, String(args.command), ...((args.args as string[] | undefined) ?? []), "--as", "perch"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? homedir(), FLINT_AGENT: "perch" },
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code === 2) return { content: "Flint is not running. Ask the user to open it.", isError: true };
  const text = (code === 0 ? stdout : stderr || stdout).trim();
  const cut = text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}… (${text.length.toLocaleString("en-US")} characters, cut)` : text;
  return code === 0 ? { content: cut || "done" } : { content: cut || `flint exited with ${code}`, isError: true };
}
