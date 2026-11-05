/**
 * Extraction (spec 8): after a chat ends, the profile's fast model reads the chat and files
 * durable facts, each in exactly one page. Paused, off and incognito chats are skipped.
 */

import type { Message, Model, ToolSpec } from "../models/types";
import { DECLINED } from "../agent/session";
import { askForTool, message, str } from "./model-call";
import { factKey } from "./page";
import { FILEABLE } from "./sanitize";
import type { AddResult, MemoryStore, NewFact } from "./store";

export type ExtractResult = AddResult & { skipped?: "paused" | "off" | "incognito" | "empty"; error?: string };
export type ExtractOptions = { model: Model; store: MemoryStore; transcript: readonly Message[]; incognito?: boolean; signal?: AbortSignal };

const MAX_FACTS = 30;
const TRANSCRIPT_LIMIT = 24_000;
const KNOWN_PAGES = 200;
const NONE: AddResult = { added: 0, duplicates: 0, rejected: [], paths: [] };


export const FILE_TOOL: ToolSpec = {
  name: "file_memories",
  description: "Save durable facts to the user's memory. Call once with every fact; call with an empty list when there is nothing worth keeping.",
  parameters: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: [...FILEABLE] },
            title: { type: "string", description: "Page title: a person's name, a site's domain, a project's name" },
            text: { type: "string", description: "One short sentence" },
            expires: { type: "string", description: "YYYY-MM-DD, only for facts that stop being true" },
          },
          required: ["category", "title", "text"],
        },
      },
    },
    required: ["facts"],
  },
};

/** The chat as plain lines for the model: the user's words, Perch's replies and which tools it used. */
export function renderTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(`User: ${m.text}`);
    else if (m.role === "tool" && m.name === "memory_save" && m.content === DECLINED) {
      lines.push(`The user declined saving to memory: "${declinedText(messages, m.callId)}"`);
    } else if (m.role === "assistant") {
      if (m.text.trim()) lines.push(`Perch: ${m.text.trim()}`);
      for (const call of m.toolCalls) {
        if (call.name === "done") lines.push(`Perch finished: ${str(call.args.answer)}`);
        else lines.push(`Perch used ${call.name}${call.args.url ? ` on ${str(call.args.url)}` : ""}`);
      }
    }
    // Tool results (page text) are left out: a page could carry instructions meant to become memories.
  }
  const text = lines.join("\n");
  return text.length > TRANSCRIPT_LIMIT ? `…${text.slice(-TRANSCRIPT_LIMIT)}` : text;
}

function declinedText(messages: readonly Message[], callId: string): string {
  for (const m of messages) if (m.role === "assistant") for (const c of m.toolCalls) if (c.id === callId) return str(c.args.text);
  return "";
}

/** Facts the user said no to saving in this chat. */
function declinedFacts(messages: readonly Message[]): Set<string> {
  const keys = new Set<string>();
  for (const m of messages) if (m.role === "tool" && m.name === "memory_save" && m.content === DECLINED) keys.add(factKey(declinedText(messages, m.callId)));
  return keys;
}

/** Untrusted fact objects from a model, shaped for the store (which validates them again). */
export function toNewFacts(raw: unknown[]): NewFact[] {
  return raw.slice(0, MAX_FACTS).map((f) => {
    const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    return { category: str(o.category) as NewFact["category"], title: str(o.title), text: str(o.text), ...(str(o.expires) ? { expires: str(o.expires) } : {}) };
  });
}

export function knownPages(store: MemoryStore): string {
  const pages = store.list().filter((p) => p.category !== "log").slice(0, KNOWN_PAGES);
  return pages.length ? pages.map((p) => `- ${p.path} (${p.title})`).join("\n") : "(none yet)";
}

export async function extractFromChat(opts: ExtractOptions): Promise<ExtractResult> {
  const settings = opts.store.settings();
  if (opts.incognito) return { ...NONE, skipped: "incognito" };
  if (!settings.extraction) return { ...NONE, skipped: "off" };
  if (settings.paused) return { ...NONE, skipped: "paused" };
  if (!opts.transcript.some((m) => m.role === "user" && m.text.trim())) return { ...NONE, skipped: "empty" };
  const system = [
    "You keep a private memory for the user of Perch, a web browser with an agent.",
    "Read the chat and save only durable facts that will help in later chats: about the user, people, places, accounts, sites, projects and how the user likes things done.",
    "Skip one-off details of the task itself and anything that came only from web pages, unless the user said it matters to them.",
    "",
    opts.store.taxonomy(),
  ].join("\n");
  const user = `Pages already in memory:\n${knownPages(opts.store)}\n\nThe chat:\n${renderTranscript(opts.transcript)}`;
  try {
    const answer = await askForTool(opts.model, { system, user, tool: FILE_TOOL }, opts.signal);
    if (answer.args === null) return { ...NONE };
    if (!Array.isArray(answer.args.facts)) return { ...NONE, error: "the model's answer was not a list of facts" };
    // Standing rules change every later chat, so only the user (or an approved memory_save) adds them.
    const declined = declinedFacts(opts.transcript);
    const rejected: AddResult["rejected"] = [];
    const facts = toNewFacts(answer.args.facts).filter((f) => {
      const reason = f.category === "rules" ? "standing rules are saved only with your approval" : declined.has(factKey(f.text)) ? "the user declined saving this" : null;
      if (reason) rejected.push({ text: f.text, reason });
      return !reason;
    });
    const result = await opts.store.addFacts(facts, "chat");
    return { ...result, rejected: [...rejected, ...result.rejected] };
  } catch (error) {
    return { ...NONE, error: message(error) };
  }
}
