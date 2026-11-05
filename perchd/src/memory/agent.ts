/**
 * Memory inside a chat: what the agent knows at the start (USER.md, MEMORY.md and the pages that
 * match the task), the memory_search and memory_save tools, and extraction when the chat ends.
 * memory_save is a "change": it waits for approval in Ask mode and runs in Guard and Skip, except
 * saving to USER.md or MEMORY.md, which always asks because both go into every later chat. In a
 * chat nobody is watching (an unattended routine run) every save asks, so it is declined and listed.
 * Incognito chats get no memory at all.
 */

import type { AuditLog } from "../agent/audit";
import { needsApproval, type Kind, type Mode } from "../agent/permissions";
import { DECLINED, type ApprovalRequest } from "../agent/session";
import type { Message, Model, ToolCall, ToolSpec } from "../models/types";
import { extractFromChat, type ExtractResult } from "./extract";
import { message, str } from "./model-call";
import { FILEABLE, isCategory } from "./sanitize";
import type { MemoryStore } from "./store";

export type MemoryToolResult = { content: string; isError?: boolean; label?: string };

export type MemoryAccess = {
  readonly specs: readonly ToolSpec[];
  handles(name: string): boolean;
  /** The memory part of the system prompt for this task. Empty when nothing is known. */
  context(task: string): Promise<string>;
  kind(call: ToolCall): Kind;
  /** True when this call must ask whatever the permission mode. */
  mustAsk(call: ToolCall): boolean;
  summary(call: ToolCall): string;
  run(call: ToolCall): Promise<MemoryToolResult>;
  chatEnded(transcript: readonly Message[]): void;
};

export type MemoryPolicy = { mode: Mode; approve: (request: ApprovalRequest) => Promise<boolean>; audit: AuditLog; client?: string };

const SEARCH_LIMIT = 5;
const FACTS_SHOWN = 12;

/** The memory tools; memory_save carries the user's TAXONOMY.md so the agent files the way they want. */
export const memorySpecs = (taxonomy: string): readonly ToolSpec[] => [
  {
    name: "memory_search",
    description: "Search the user's memory: people, places, accounts, sites, projects and preferences. Returns matching pages with their facts.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "memory_save",
    description: `Save one durable fact the user told you or asked you to remember.\n${taxonomy}`,
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: FILEABLE.filter((c) => c !== "episodic") },
        title: { type: "string", description: "Page title: a person's name, a site's domain; anything for user and rules" },
        text: { type: "string", description: "One short sentence" },
        expires: { type: "string", description: "YYYY-MM-DD, only for facts that stop being true" },
      },
      required: ["category", "title", "text"],
      additionalProperties: false,
    },
  },
];

const CONTEXT_NOTE =
  "What Perch remembers about the user. Use it the way a person would, without reciting it. Search memory for more; save a fact only when the user shares something durable or asks you to remember it.";

function checkArgs(call: ToolCall): string | null {
  const allowed = call.name === "memory_search" ? ["query", "limit"] : ["category", "title", "text", "expires"];
  const required = call.name === "memory_search" ? ["query"] : ["category", "title", "text"];
  if ("__unparsed" in call.args) return `the arguments for "${call.name}" were not valid JSON`;
  for (const key of required) if (typeof call.args[key] !== "string" || !String(call.args[key]).trim()) return `missing argument "${key}"`;
  for (const key of Object.keys(call.args)) if (!allowed.includes(key)) return `unexpected argument "${key}"`;
  return null;
}

export type ChatMemoryOptions = { incognito?: boolean; unattended?: boolean; extractWith?: Model; onExtracted?: (result: ExtractResult) => void };

export function chatMemory(store: MemoryStore, opts: ChatMemoryOptions = {}): MemoryAccess | undefined {
  if (opts.incognito) return undefined;
  const pathFor = (call: ToolCall) => {
    const category = str(call.args.category);
    if (category === "user") return "USER.md";
    if (category === "rules") return "MEMORY.md";
    return null;
  };
  return {
    specs: memorySpecs(store.taxonomy()),
    handles: (name) => name === "memory_search" || name === "memory_save",
    async context(task) {
      const known = store.context();
      const recalled = await store.recall(task).catch(() => "");
      const body = [known, recalled ? `Pages that may help with this task:\n${recalled}` : ""].filter(Boolean).join("\n\n");
      return body ? `${CONTEXT_NOTE}\n\n${body}` : "";
    },
    kind: (call) => (call.name === "memory_search" ? "read" : "change"),
    mustAsk: (call) => call.name === "memory_save" && (Boolean(opts.unattended) || pathFor(call) !== null),
    summary(call) {
      if (call.name === "memory_search") return `Search memory for "${str(call.args.query)}"`;
      const where = pathFor(call) ?? `${str(call.args.category)}: ${str(call.args.title)}`;
      return `Save to memory (${where}): "${str(call.args.text)}"`;
    },
    async run(call) {
      const problem = checkArgs(call);
      if (problem) return { content: problem, isError: true };
      if (call.name === "memory_search") {
        const limit = Math.max(1, Math.min(10, Number(call.args.limit) || SEARCH_LIMIT));
        const hits = await store.search(str(call.args.query), { limit });
        if (!hits.length) return { content: "Nothing in memory matches.", label: "Searched memory" };
        const blocks = hits.map((h) => {
          const facts = store.get(h.id)?.current.slice(0, FACTS_SHOWN) ?? [];
          return `${h.path} (${h.title})\n${facts.map((f) => `- ${f.text}`).join("\n")}`;
        });
        return { content: blocks.join("\n\n"), label: "Searched memory" };
      }
      const category = str(call.args.category);
      if (!isCategory(category) || !FILEABLE.includes(category) || category === "episodic") return { content: "Not saved: unknown category.", isError: true };
      const result = await store.addFacts([{ category, title: str(call.args.title), text: str(call.args.text), ...(str(call.args.expires) ? { expires: str(call.args.expires) } : {}) }], "agent");
      if (result.rejected.length) return { content: `Not saved: ${result.rejected[0]!.reason}.`, isError: true };
      if (result.duplicates) return { content: "Already in memory.", label: "Checked memory" };
      return { content: `Saved to ${result.paths[0] ?? "memory"}.`, label: "Saved to memory" };
    },
    chatEnded(transcript) {
      if (!opts.extractWith) return;
      void extractFromChat({ model: opts.extractWith, store, transcript })
        .catch((error): ExtractResult => ({ added: 0, duplicates: 0, rejected: [], paths: [], error: message(error) }))
        .then((result) => opts.onExtracted?.(result));
    },
  };
}

/** What the plaintext audit log may say about a memory call: never the query or the fact itself. */
function auditDetail(call: ToolCall): string {
  if (call.name === "memory_search") return `search (${str(call.args.query).length} characters)`;
  const category = str(call.args.category);
  return `save to ${isCategory(category) ? category : "an unknown category"}`;
}

/** One memory tool call under the chat's permission mode: approval if needed, run, audit. */
export async function* memoryCall(memory: MemoryAccess, policy: MemoryPolicy, call: ToolCall): AsyncGenerator<{ type: "approval"; request: ApprovalRequest } | { type: "step"; label: string }, MemoryToolResult> {
  const kind = memory.kind(call);
  const decision = memory.mustAsk(call) ? "ask" : needsApproval(policy.mode, kind);
  const entry = { time: new Date().toISOString(), tab: "", site: "memory", action: call.name, detail: auditDetail(call), client: policy.client ?? "sidebar" };
  let approved: boolean | null = null;
  if (decision === "ask") {
    const request: ApprovalRequest = { call, kind, site: "memory", summary: memory.summary(call) };
    yield { type: "approval", request };
    approved = await policy.approve(request);
    if (!approved) {
      await policy.audit.append({ ...entry, approved: false, result: "declined" });
      return { content: DECLINED, isError: true };
    }
  }
  const result = await memory.run(call).catch((error): MemoryToolResult => ({ content: message(error), isError: true }));
  await policy.audit.append({ ...entry, approved, result: result.isError ? "error" : "ok" });
  if (!result.isError && result.label) yield { type: "step", label: result.label };
  return result;
}
