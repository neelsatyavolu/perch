/**
 * Memory inside a chat: what the agent knows at the start (USER.md, MEMORY.md and the pages that
 * match the task), the memory_search and memory_save tools, and extraction when the chat ends.
 * memory_save is a "change": it waits for approval in Ask mode and runs in Guard and Skip, except
 * saving to USER.md or MEMORY.md, which always asks because both go into every later chat. In a
 * chat nobody is watching (an unattended routine run) every save asks, so it is declined and listed.
 * Incognito chats get no memory at all.
 */

import { proposeToDraft, type DraftHolder } from "./setup";
import type { HistoryRow } from "./sources";
import type { AuditWriter } from "../agent/audit";
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
  /**
   * The memory part of the prompt for this turn. `hints` name the user's own message (recall
   * matches it rather than the whole task text), the tab's address (its site page comes in) and
   * the chat (facts shown earlier in it are not shown again). Empty when nothing is known.
   */
  context(task: string, hints?: MemoryHints): Promise<string>;
  kind(call: ToolCall): Kind;
  /** True when this call must ask whatever the permission mode. */
  mustAsk(call: ToolCall): boolean;
  summary(call: ToolCall): string;
  run(call: ToolCall): Promise<MemoryToolResult>;
  chatEnded(transcript: readonly Message[]): void;
};

export type MemoryHints = { message?: string; url?: string; chatId?: string };

export type MemoryPolicy = { mode: Mode; approve: (request: ApprovalRequest) => Promise<boolean>; audit: AuditWriter; client?: string };

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

/** How the agent should use what it remembers (after Aside's memory prompt). */
const CONTEXT_NOTE = [
  "# Memory",
  "You remember this user. What follows is what you know about them; memory_search recalls more.",
  "- Use it like your own memory: naturally, without mentioning notes, files or pages.",
  "- Be exactly as sure as your memory is. Keep specifics exact (names, numbers, addresses). Newer records win over older ones; when a fact may have changed, say when you last knew it (\"as of 7 Oct\").",
  "- For plans, deadlines, logistics, money or decisions, search memory for the whole record rather than relying on one line.",
  "- If you don't recall something the task needs, search memory before asking the user.",
  "- Save with memory_save only when the user shares something durable or asks you to remember it; Perch learns the rest from the chat by itself.",
].join("\n");

/** Facts already shown in each chat, so recall doesn't repeat itself turn after turn. */
const shownInChat = new Map<string, Set<string>>();
const CHATS_REMEMBERED = 200;

function shownFor(chatId: string | undefined): Set<string> {
  if (!chatId) return new Set();
  let shown = shownInChat.get(chatId);
  if (!shown) {
    shown = new Set();
    shownInChat.set(chatId, shown);
    if (shownInChat.size > CHATS_REMEMBERED) shownInChat.delete(shownInChat.keys().next().value!);
  }
  return shown;
}

function checkArgs(call: ToolCall): string | null {
  const allowed = call.name === "memory_search" ? ["query", "limit"] : ["category", "title", "text", "expires"];
  const required = call.name === "memory_search" ? ["query"] : ["category", "title", "text"];
  if ("__unparsed" in call.args) return `the arguments for "${call.name}" were not valid JSON`;
  for (const key of required) if (typeof call.args[key] !== "string" || !String(call.args[key]).trim()) return `missing argument "${key}"`;
  for (const key of Object.keys(call.args)) if (!allowed.includes(key)) return `unexpected argument "${key}"`;
  return null;
}

export type ChatMemoryOptions = {
  incognito?: boolean;
  unattended?: boolean;
  extractWith?: Model;
  onExtracted?: (result: ExtractResult) => void;
  /** The review draft: memory_propose (Build my memory) adds to it; nothing is saved until the user does. */
  draft?: DraftHolder;
  /** The browser's history, for browsing_history. */
  history?: () => Promise<HistoryRow[]>;
};

/** Build my memory's tools: research goes to a review draft, never straight into memory. */
export const researchSpecs: readonly ToolSpec[] = [
  {
    name: "memory_propose",
    description:
      "Add facts you found about the user to the review draft on the Memory page (perch://memory#review). Nothing is saved until the user reviews it. One short fact per item; never passwords, card numbers, codes or ID numbers.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string", enum: ["user", "people", "places", "companies", "writing", "sites", "projects", "concepts", "routines"] },
              title: { type: "string", description: "Page title: a person's name, a site's domain, a project's name; anything for user" },
              text: { type: "string", description: "One short sentence" },
            },
            required: ["category", "title", "text"],
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "browsing_history",
    description: "Search the user's browsing history (last 90 days): sites and page titles, most visited first. Leave query empty for the top sites.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, additionalProperties: false },
  },
];
const HISTORY_LIMIT = 60;

export function chatMemory(store: MemoryStore, opts: ChatMemoryOptions = {}): MemoryAccess | undefined {
  if (opts.incognito) return undefined;
  const pathFor = (call: ToolCall) => {
    const category = str(call.args.category);
    if (category === "user") return "USER.md";
    if (category === "rules") return "MEMORY.md";
    return null;
  };
  return {
    specs: [...memorySpecs(store.taxonomy()), ...(opts.draft && !opts.unattended ? researchSpecs.filter((s) => s.name !== "browsing_history" || opts.history) : [])],
    handles: (name) => name === "memory_search" || name === "memory_save" || (Boolean(opts.draft) && !opts.unattended && (name === "memory_propose" || (name === "browsing_history" && Boolean(opts.history)))),
    async context(task, hints = {}) {
      const known = store.context();
      const shown = shownFor(hints.chatId);
      let recalled = "";
      try {
        const recall = store.recallFor(hints.message?.trim() || task, { ...(hints.url ? { url: hints.url } : {}), exclude: shown });
        recalled = recall.text;
        for (const key of recall.keys) shown.add(key);
      } catch {
        // Recall is a help, never a reason for a turn to fail.
      }
      const body = [known, recalled].filter(Boolean).join("\n\n");
      return body ? `${CONTEXT_NOTE}\n\n${body}` : "";
    },
    // Proposals only fill the review draft, which the user approves on the Memory page.
    kind: (call) => (call.name === "memory_save" ? "change" : "read"),
    mustAsk: (call) => call.name === "memory_save" && (Boolean(opts.unattended) || pathFor(call) !== null),
    summary(call) {
      if (call.name === "memory_search") return `Search memory for "${str(call.args.query)}"`;
      if (call.name === "memory_propose") return "Add findings to the memory draft";
      if (call.name === "browsing_history") return `Search browsing history${str(call.args.query) ? ` for "${str(call.args.query)}"` : ""}`;
      const where = pathFor(call) ?? `${str(call.args.category)}: ${str(call.args.title)}`;
      return `Save to memory (${where}): "${str(call.args.text)}"`;
    },
    async run(call) {
      if (call.name === "memory_propose" && opts.draft) {
        if (!Array.isArray(call.args.items)) return { content: 'missing argument "items"', isError: true };
        const items = (call.args.items as unknown[]).filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === "object");
        const result = proposeToDraft(opts.draft.current, items, new Date());
        opts.draft.current = result.draft;
        const why = result.rejected.length ? ` Left out ${result.rejected.length}: ${result.rejected.slice(0, 5).map((r) => `"${r.text.slice(0, 60)}" (${r.reason})`).join("; ")}.` : "";
        return {
          content: `Added ${result.added} to the review draft (${result.draft.items.length} in all).${why} The user reviews and saves them at perch://memory#review; tell them to open it when you finish.`,
          label: `Added ${result.added} ${result.added === 1 ? "finding" : "findings"} to the memory draft`,
        };
      }
      if (call.name === "browsing_history" && opts.history) {
        const words = str(call.args.query).toLowerCase().split(/\s+/).filter(Boolean);
        const limit = Math.max(1, Math.min(200, Number(call.args.limit) || HISTORY_LIMIT));
        const rows = (await opts.history()).filter((r) => words.every((w) => `${r.title} ${r.url}`.toLowerCase().includes(w)));
        if (!rows.length) return { content: "Nothing in the browsing history matches.", label: "Searched browsing history" };
        const lines = [...rows].sort((a, b) => b.visits - a.visits).slice(0, limit).map((r) => `${r.title || "(untitled)"} | ${r.url} | ${r.visits} visits, last ${r.lastVisit.slice(0, 10)}`);
        return { content: lines.join("\n"), label: "Searched browsing history" };
      }
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
  if (call.name === "memory_propose") return `propose ${Array.isArray(call.args.items) ? call.args.items.length : 0} facts for review`;
  if (call.name === "browsing_history") return `history search (${str(call.args.query).length} characters)`;
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
