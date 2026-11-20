/**
 * What a sidebar chat's outside agent (Codex, Claude Code) can use besides the browser: the
 * profile's skills (built-in and imported, through load_skill) and its memory (memory_search,
 * memory_save). Perch's own agent loop gets the same through ExtraTools; this hands them to the
 * daemon for one sidebar run, and the skill list to the task text.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { readLocalDocument } from "../agent/local-document";
import { isZip, openZip } from "./zip-attachment";
import type { MemoryAccess } from "../memory/agent";
import type { ToolCall } from "../models/types";
import { combineExtraTools, type ExtraTools } from "../mcp-client/extra-tools";
import type { SkillCatalog } from "../skills/catalog";
import { skillExtraTools } from "../skills/tool";

/** ExtraTools plus the calls that ask whatever the chat's mode is. */
export type SidebarExtras = ExtraTools & { mustAsk(call: ToolCall): boolean };

const MEMORY_LABELS: Record<string, string> = {
  memory_search: "Searched memory",
  memory_save: "Saved to memory",
  memory_propose: "Added findings to the memory draft",
  browsing_history: "Searched browsing history",
};

/** Memory as ExtraTools; memory_save asks when MemoryAccess says it must (USER.md, MEMORY.md). */
export function memoryExtraTools(memory: MemoryAccess): ExtraTools {
  return {
    specs: () => [...memory.specs],
    prompt: () => "",
    handles: (name) => memory.handles(name),
    check: () => null,
    describe: (call) => ({
      kind: memory.kind(call),
      site: "memory",
      summary: memory.summary(call),
      detail: call.name,
      label: MEMORY_LABELS[call.name] ?? "Used memory",
    }),
    run: (call) => memory.run(call),
  };
}

export const READ_ATTACHMENT = "read_attachment";
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** Documents read as text (a PDF page can also be seen as an image). */
const DOCUMENT_EXT = /\.(pdf|docx|pptx|xlsx)$/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|mjs|ts|tsx|py|rb|go|rs|java|c|cc|cpp|h|sh|log|ini|toml|sql|tex|srt|vtt)$/i;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_TEXT = 200_000;
/** Entries one folder listing shows. */
const MAX_LISTING = 500;

/** "proj/src/a.ts" against the attached names: the attachment and the path inside it, or null. */
function splitName(name: string, byName: ReadonlyMap<string, string>): { root: string; inner: string } | null {
  if (byName.has(name)) return { root: byName.get(name)!, inner: "" };
  const slash = name.indexOf("/");
  if (slash < 0) return null;
  const root = byName.get(name.slice(0, slash));
  const inner = name.slice(slash + 1).replace(/\/+$/, "");
  if (!root || !inner || inner.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  return { root, inner };
}

/** The real path of a file inside an attached folder; null when it is missing or (through a link) outside it. */
async function insideFolder(root: string, inner: string): Promise<string | null> {
  const base = await realpath(root);
  const target = await realpath(join(base, inner)).catch(() => null);
  return target && (target === base || target.startsWith(base + sep)) ? target : null;
}

async function listFolder(name: string, path: string): Promise<string> {
  const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const shown = entries.slice(0, MAX_LISTING).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  const more = entries.length > MAX_LISTING ? `\n… and ${entries.length - MAX_LISTING} more` : "";
  return entries.length ? `${name}/ holds:\n${shown.join("\n")}${more}` : `${name}/ is empty.`;
}

/**
 * The files the user attached to this message, readable by name: text and documents as text,
 * images and PDF pages as images the model can see. An attached folder lists by its name, and a
 * file in it reads as "folder/path/in/it"; an attached .zip opens the same way. Nothing else on the
 * Mac is reachable through it.
 */
export function attachmentExtraTools(files: readonly { name: string; path: string }[]): ExtraTools | undefined {
  if (!files.length) return undefined;
  const byName = new Map(files.map((f) => [f.name, f.path]));
  return {
    specs: () => [
      {
        name: READ_ATTACHMENT,
        description: "Read a file the user attached to this message: text files, PDFs, Word, PowerPoint and Excel come back as text, images (screenshots, photos) as images you can see. For an attached folder or .zip, its name lists what is in it, and folder/path/to/file reads a file inside it (folder/sub lists a subfolder). Pass page to see one PDF page as an image (scans, handwriting), from to read on in long ones.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: `One of: ${files.map((f) => f.name).join(", ").slice(0, 400)}, or a path inside an attached folder` },
            page: { type: "number", description: "A PDF page number (1 is the first) to see as an image" },
            from: { type: "number", description: "Character to start at, from the last part's note" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
    prompt: () => `The user attached: ${files.map((f) => f.name).join(", ")}. Call ${READ_ATTACHMENT} with a name to read one; a folder's or .zip's name lists it, and folder/path reads a file in it.`,
    handles: (name) => name === READ_ATTACHMENT,
    check: (call) => (typeof call.args.name === "string" && splitName(call.args.name, byName) ? null : `name must be one of the attached files, or a path inside an attached folder: ${[...byName.keys()].join(", ")}`),
    describe: (call) => ({ kind: "read", site: "attachments", summary: `Read ${String(call.args.name)}`, detail: "attachment", label: `Read ${String(call.args.name)}` }),
    async run(call) {
      const name = String(call.args.name);
      const split = splitName(name, byName)!;
      let root = split.root;
      if (isZip(root)) {
        try {
          root = await openZip(root);
        } catch (error) {
          return { content: (error as Error).message, isError: true };
        }
      }
      const inner = split.inner;
      const path = inner ? await insideFolder(root, inner) : root;
      if (!path) return { content: `${name} isn't in the attached folder.`, isError: true };
      const info = await stat(path);
      if (info.isDirectory()) return { content: await listFolder(name, path) };
      const size = info.size;
      const imageType = IMAGE_TYPES[extname(path).toLowerCase()];
      if (imageType) {
        if (size > MAX_IMAGE) return { content: `${name} is too large to show (${Math.round(size / 1048576)} MB).`, isError: true };
        return { content: `${name} (image)`, image: (await readFile(path)).toString("base64"), imageType };
      }
      if (DOCUMENT_EXT.test(path)) {
        const page = call.args.page === undefined ? undefined : Math.max(1, Math.floor(Number(call.args.page)) || 1);
        return readLocalDocument(path, { from: Number(call.args.from ?? 0) || 0, page, tool: READ_ATTACHMENT, title: name });
      }
      if (!TEXT_EXT.test(path)) return { content: `${name} isn't a document, text file or image; upload it where the task needs it instead.`, isError: true };
      const text = (await readFile(path, "utf8")).slice(0, MAX_TEXT);
      return { content: size > MAX_TEXT ? `${text}\n… (cut at ${MAX_TEXT} characters)` : text };
    },
  };
}

export const SCHEDULE_MESSAGE = "schedule_message";

/** "Do this at 12am": the chat sends itself the message at that time. One the user approves up front runs without asking before sends and publishing. */
export function scheduleExtraTools(schedule: (at: Date, text: string, preapproved: boolean) => Promise<{ at: string }>, now: () => Date = () => new Date()): ExtraTools {
  const when = (call: ToolCall) => new Date(String(call.args.at));
  return {
    specs: () => [
      {
        name: SCHEDULE_MESSAGE,
        description:
          "Do something later: at the given time this chat receives the message as if the user sent it, and you carry it out then. Use it when the user asks for a task at a time (\"publish at 12am\"). Set preapprove when the task's final step (send, post, publish) should run unattended; the user approves that now.",
        parameters: {
          type: "object",
          properties: {
            at: { type: "string", description: "Local date and time, like 2026-11-11T00:00" },
            text: { type: "string", description: "The task to do then, written as the user's request" },
            preapprove: { type: "boolean", description: "Let the scheduled task send, post or publish without asking (payments still ask)" },
          },
          required: ["at", "text"],
          additionalProperties: false,
        },
      },
    ],
    prompt: () => {
      const d = now();
      return `It is now ${d.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}). For a task at a later time, use ${SCHEDULE_MESSAGE}.`;
    },
    handles: (name) => name === SCHEDULE_MESSAGE,
    check: (call) => {
      if (typeof call.args.text !== "string" || !call.args.text.trim()) return "text is required";
      if (typeof call.args.at !== "string" || !Number.isFinite(when(call).getTime())) return "at must be a date and time like 2026-11-11T00:00";
      return null;
    },
    describe: (call) => {
      const at = when(call).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const unattended = call.args.preapprove === true ? ", and let it send, post or publish without asking (payments still ask)" : "";
      return { kind: "change", site: "schedule", summary: `At ${at}, do: "${String(call.args.text)}"${unattended}`, detail: "schedule", label: `Scheduled for ${at}` };
    },
    async run(call) {
      const item = await schedule(when(call), String(call.args.text), call.args.preapprove === true);
      return { content: `Scheduled for ${new Date(item.at).toLocaleString()}. This chat will carry it out then; Perch must be running.` };
    },
  };
}

/**
 * The extras for one sidebar run: skills always, memory unless the chat is private, this message's
 * attachments, and scheduling. `skillsRead` is the chat's record of the skills it already read
 * (skills/tool.ts), so later messages get them in their instructions.
 */
export function sidebarExtras(
  catalog: SkillCatalog | undefined,
  memory: MemoryAccess | undefined,
  files: readonly { name: string; path: string }[] = [],
  schedule?: (at: Date, text: string, preapproved: boolean) => Promise<{ at: string }>,
  skillsRead?: Set<string>,
): SidebarExtras | undefined {
  const parts = [catalog ? skillExtraTools(catalog, skillsRead) : undefined, memory ? memoryExtraTools(memory) : undefined, attachmentExtraTools(files), schedule ? scheduleExtraTools(schedule) : undefined].filter(
    (p): p is ExtraTools => Boolean(p),
  );
  if (!parts.length) return undefined;
  // A memory save that must ask, and any pre-approved schedule, ask whatever the chat's mode.
  return { ...combineExtraTools(...parts), mustAsk: (call) => Boolean(memory?.handles(call.name) && memory.mustAsk(call)) || (call.name === SCHEDULE_MESSAGE && call.args.preapprove === true) };
}
