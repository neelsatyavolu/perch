/**
 * What a sidebar chat's outside agent (Codex, Claude Code) can use besides the browser: the
 * profile's skills (built-in and imported, through load_skill) and its memory (memory_search,
 * memory_save). Perch's own agent loop gets the same through ExtraTools; this hands them to the
 * daemon for one sidebar run, and the skill list to the task text.
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { MemoryAccess } from "../memory/agent";
import type { ToolCall } from "../models/types";
import { combineExtraTools, type ExtraTools } from "../mcp-client/extra-tools";
import type { SkillCatalog } from "../skills/catalog";
import { skillExtraTools } from "../skills/tool";

/** ExtraTools plus the calls that ask whatever the chat's mode is. */
export type SidebarExtras = ExtraTools & { mustAsk(call: ToolCall): boolean };

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
      label: call.name === "memory_search" ? "Searched memory" : "Saved to memory",
    }),
    run: (call) => memory.run(call),
  };
}

export const READ_ATTACHMENT = "read_attachment";
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|mjs|ts|tsx|py|rb|go|rs|java|c|cc|cpp|h|sh|log|ini|toml|sql|tex|srt|vtt)$/i;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_TEXT = 200_000;

/**
 * The files the user attached to this message, readable by name: text as text, images as images
 * the model can see. Nothing else on the Mac is reachable through it.
 */
export function attachmentExtraTools(files: readonly { name: string; path: string }[]): ExtraTools | undefined {
  if (!files.length) return undefined;
  const byName = new Map(files.map((f) => [f.name, f.path]));
  return {
    specs: () => [
      {
        name: READ_ATTACHMENT,
        description: "Read a file the user attached to this message: text files come back as text, images (screenshots, photos) as images you can see.",
        parameters: { type: "object", properties: { name: { type: "string", description: `One of: ${files.map((f) => f.name).join(", ").slice(0, 400)}` } }, required: ["name"], additionalProperties: false },
      },
    ],
    prompt: () => `The user attached: ${files.map((f) => f.name).join(", ")}. Call ${READ_ATTACHMENT} with a name to read one.`,
    handles: (name) => name === READ_ATTACHMENT,
    check: (call) => (typeof call.args.name === "string" && byName.has(call.args.name) ? null : `name must be one of the attached files: ${[...byName.keys()].join(", ")}`),
    describe: (call) => ({ kind: "read", site: "attachments", summary: `Read ${String(call.args.name)}`, detail: "attachment", label: `Read ${String(call.args.name)}` }),
    async run(call) {
      const name = String(call.args.name);
      const path = byName.get(name)!;
      const size = (await stat(path)).size;
      const imageType = IMAGE_TYPES[extname(path).toLowerCase()];
      if (imageType) {
        if (size > MAX_IMAGE) return { content: `${name} is too large to show (${Math.round(size / 1048576)} MB).`, isError: true };
        return { content: `${name} (image)`, image: (await readFile(path)).toString("base64"), imageType };
      }
      if (!TEXT_EXT.test(path)) return { content: `${name} isn't a text file or an image; upload it where the task needs it instead.`, isError: true };
      const text = (await readFile(path, "utf8")).slice(0, MAX_TEXT);
      return { content: size > MAX_TEXT ? `${text}\n… (cut at ${MAX_TEXT} characters)` : text };
    },
  };
}

/** The extras for one sidebar run: skills always, memory unless the chat is private, and this message's attachments. */
export function sidebarExtras(catalog: SkillCatalog | undefined, memory: MemoryAccess | undefined, files: readonly { name: string; path: string }[] = []): SidebarExtras | undefined {
  const parts = [catalog ? skillExtraTools(catalog) : undefined, memory ? memoryExtraTools(memory) : undefined, attachmentExtraTools(files)].filter((p): p is ExtraTools => Boolean(p));
  if (!parts.length) return undefined;
  return { ...combineExtraTools(...parts), mustAsk: (call) => Boolean(memory?.handles(call.name) && memory.mustAsk(call)) };
}
