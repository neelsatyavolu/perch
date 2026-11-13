/**
 * "Set up your memory" (spec 8). The user picks sources, the model drafts a profile grouped as
 * About you, People, Places and accounts, Writing style and Sites, and the user edits or removes
 * any item on the review page. Drafts are plain values kept in RAM; nothing is saved until
 * saveProfile. Groups with nothing in them are listed as gaps for the user to fill.
 */

import type { Model, ToolSpec } from "../models/types";
import { askForTool, message, str } from "./model-call";
import { newId } from "./page";
import { cleanText, looksSecret, MAX_TITLE, type Category } from "./sanitize";
import { summarizeBookmarks, summarizeChats, summarizeHistory, summarizeTabs, type Bookmark, type ChatSummary, type HistoryRow, type TabRow } from "./sources";
import type { AddResult, MemoryStore } from "./store";
import { DEFAULT_TAXONOMY } from "./taxonomy";

export type SourceId = "history" | "bookmarks" | "tabs" | "chats" | "questionnaire" | "webSearch" | "research";
export type SetupSources = Record<SourceId, boolean>;
export type SourceInfo = { id: SourceId; label: string; description: string; available: boolean };

export const SOURCES: readonly SourceInfo[] = [
  { id: "history", label: "Browsing history", description: "Sites you visited in the last 90 days, by domain and page title.", available: true },
  { id: "bookmarks", label: "Bookmarks", description: "Your bookmarks and their folders.", available: true },
  { id: "tabs", label: "Open tabs", description: "Titles and sites of the tabs open now.", available: true },
  { id: "chats", label: "Chats", description: "The first message of your recent Perch chats.", available: true },
  { id: "questionnaire", label: "A few questions", description: "Five short questions you answer yourself.", available: true },
  { id: "webSearch", label: "Web search on your name", description: "Not available yet. Off by default.", available: false },
  // What "Build my memory" found: the agent researching in a chat (memory_propose), not a source to pick.
  { id: "research", label: "Perch's research", description: "Found by the agent in a Build my memory chat.", available: false },
];
export const DEFAULT_SOURCES: SetupSources = { history: true, bookmarks: true, tabs: true, chats: true, questionnaire: true, webSearch: false, research: false };

export const QUESTIONS = [
  { id: "name", text: "What should Perch call you?" },
  { id: "work", text: "What do you do, for work or study?" },
  { id: "home", text: "Where do you live? A city is enough." },
  { id: "writing", text: "How should messages written for you sound? For example: short, friendly, no emoji." },
  { id: "never", text: "Is there anything Perch should never do for you?" },
] as const;

export type Group = "about" | "people" | "places" | "writing" | "sites";
export const GROUPS: readonly { id: Group; label: string; categories: readonly Category[] }[] = [
  { id: "about", label: "About you", categories: ["user", "rules", "projects", "concepts", "routines"] },
  { id: "people", label: "People", categories: ["people"] },
  { id: "places", label: "Places and accounts", categories: ["places", "companies"] },
  { id: "writing", label: "Writing style", categories: ["writing"] },
  { id: "sites", label: "Sites", categories: ["sites"] },
];

export type DraftItem = { readonly id: string; readonly group: Group; readonly category: Category; readonly title: string; readonly text: string; readonly sources: readonly SourceId[] };
export type ProfileDraft = { readonly id: string; readonly createdAt: string; readonly sources: readonly SourceId[]; readonly items: readonly DraftItem[]; readonly gaps: readonly Group[] };

export type SetupInputs = {
  history?: () => Promise<HistoryRow[]>;
  bookmarks?: () => Promise<Bookmark[]>;
  tabs?: () => Promise<TabRow[]>;
  chats?: () => Promise<ChatSummary[]>;
  answers?: Partial<Record<(typeof QUESTIONS)[number]["id"], string>>;
};

const MAX_ITEMS = 120;

const PROPOSE_TOOL: ToolSpec = {
  name: "propose_profile",
  description: "Propose memory items for the user to review. Each item is one short fact.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            group: { type: "string", enum: GROUPS.map((g) => g.id) },
            category: { type: "string", description: "Optional: user, rules, projects, concepts, routines, people, places, companies, writing or sites" },
            title: { type: "string", description: "Page title: a person's name, a site's domain, a place" },
            text: { type: "string" },
            sources: { type: "array", items: { type: "string" } },
          },
          required: ["group", "title", "text"],
        },
      },
    },
    required: ["items"],
  },
};

function groupOf(id: unknown) {
  return GROUPS.find((g) => g.id === id);
}

/** Checks one item's fields; throws a plain error the review page can show. */
function makeItem(fields: { group?: unknown; category?: unknown; title?: unknown; text?: unknown; sources?: unknown }): DraftItem {
  const group = groupOf(fields.group);
  if (!group) throw new Error("pick a group: About you, People, Places and accounts, Writing style or Sites");
  const text = cleanText(str(fields.text));
  if (!text) throw new Error("an item needs some text");
  if (looksSecret(text)) throw new Error("that looks like a secret; Perch does not keep passwords, keys or codes in memory");
  const wanted = str(fields.category) as Category;
  const category = group.categories.includes(wanted) ? wanted : group.categories[0]!;
  const title = cleanText(str(fields.title), MAX_TITLE) || group.label;
  const sources = Array.isArray(fields.sources) ? (fields.sources.filter((s) => SOURCES.some((x) => x.id === s)) as SourceId[]) : [];
  return { id: newId(), group: group.id, category, title, text, sources };
}

function withItems(draft: ProfileDraft, items: readonly DraftItem[]): ProfileDraft {
  return { ...draft, items, gaps: GROUPS.map((g) => g.id).filter((g) => !items.some((i) => i.group === g)) };
}

async function gather(sources: SetupSources, inputs: SetupInputs): Promise<string> {
  const parts: string[] = [];
  const add = async <T>(on: boolean, read: (() => Promise<T[]>) | undefined, title: string, render: (rows: T[]) => string) => {
    if (!on || !read) return;
    const text = render(await read().catch(() => []));
    if (text) parts.push(`## ${title}\n${text}`);
  };
  await add(sources.history, inputs.history, "Browsing history (last 90 days)", summarizeHistory);
  await add(sources.bookmarks, inputs.bookmarks, "Bookmarks", summarizeBookmarks);
  await add(sources.tabs, inputs.tabs, "Open tabs", summarizeTabs);
  await add(sources.chats, inputs.chats, "Recent chats", summarizeChats);
  if (sources.questionnaire) {
    const qa = QUESTIONS.flatMap((q) => {
      const answer = cleanText(str(inputs.answers?.[q.id]));
      return answer && !looksSecret(answer) ? [`Q: ${q.text}\nA: ${answer}`] : [];
    });
    if (qa.length) parts.push(`## The user's answers\n${qa.join("\n")}`);
  }
  return parts.join("\n\n");
}

export async function buildProfile(opts: { model: Model; sources: SetupSources; inputs: SetupInputs; now: Date; taxonomy?: string; signal?: AbortSignal }): Promise<{ draft: ProfileDraft } | { error: string }> {
  const material = await gather(opts.sources, opts.inputs);
  const system = [
    "You help the user of Perch, a web browser with an agent, set up its memory.",
    "From the material below, propose short facts that will help Perch write in the user's voice, find their accounts and sites, and know the people they deal with.",
    "Only state what the material supports. Do not guess names, ages, health, money or politics. Prefer fewer, solid items.",
    "",
    opts.taxonomy ?? DEFAULT_TAXONOMY,
  ].join("\n");
  const user = material || "There is no material. Propose nothing.";
  try {
    const answer = await askForTool(opts.model, { system, user, tool: PROPOSE_TOOL }, opts.signal);
    if (!answer.args || !Array.isArray(answer.args.items)) return { error: "The model did not return a profile. Try again, or pick another model." };
    const items = answer.args.items.slice(0, MAX_ITEMS).flatMap((raw) => {
      try {
        return [makeItem((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>)];
      } catch {
        return [];
      }
    });
    const on = (Object.keys(opts.sources) as SourceId[]).filter((k) => opts.sources[k]);
    return { draft: withItems({ id: newId(), createdAt: opts.now.toISOString(), sources: on, items: [], gaps: [] }, items) };
  } catch (error) {
    return { error: message(error) };
  }
}

/** The draft waiting for review, shared by the Memory page and the agent's memory_propose. */
export type DraftHolder = { current: ProfileDraft | null };

/**
 * Adds what the agent found (Build my memory) to the review draft, starting one when there is
 * none. Nothing is saved: the user reviews the draft on the Memory page. Items that fail the
 * checks (no text, a secret) or repeat one already in the draft come back as rejected.
 */
export function proposeToDraft(draft: ProfileDraft | null, items: readonly { category?: unknown; title?: unknown; text?: unknown }[], now: Date): { draft: ProfileDraft; added: number; rejected: { text: string; reason: string }[] } {
  let next = draft ?? withItems({ id: newId(), createdAt: now.toISOString(), sources: ["research"], items: [], gaps: [] }, []);
  if (!next.sources.includes("research")) next = { ...next, sources: [...next.sources, "research"] };
  const seen = new Set(next.items.map((i) => i.text.toLowerCase()));
  const rejected: { text: string; reason: string }[] = [];
  let added = 0;
  for (const raw of items.slice(0, MAX_ITEMS)) {
    const category = str(raw.category) as Category;
    const group = GROUPS.find((g) => g.categories.includes(category))?.id ?? "about";
    try {
      const item = makeItem({ group, category, title: raw.title, text: raw.text, sources: ["research"] });
      if (seen.has(item.text.toLowerCase())) {
        rejected.push({ text: item.text, reason: "already in the draft" });
        continue;
      }
      seen.add(item.text.toLowerCase());
      next = withItems(next, [...next.items, item]);
      added++;
    } catch (error) {
      rejected.push({ text: str(raw.text), reason: message(error) });
    }
  }
  if (next.items.length > MAX_DRAFT) throw new Error(`the draft is full (${MAX_DRAFT} facts); ask the user to review it first`);
  return { draft: next, added, rejected };
}
const MAX_DRAFT = 500;

export function editItem(draft: ProfileDraft, itemId: string, patch: { group?: Group; title?: string; text?: string }): ProfileDraft {
  const item = draft.items.find((i) => i.id === itemId);
  if (!item) throw new Error("no such item in this draft");
  const next = makeItem({ group: patch.group ?? item.group, category: item.category, title: patch.title ?? item.title, text: patch.text ?? item.text, sources: item.sources });
  return withItems(draft, draft.items.map((i) => (i.id === itemId ? { ...next, id: itemId } : i)));
}

export function removeItem(draft: ProfileDraft, itemId: string): ProfileDraft {
  return withItems(draft, draft.items.filter((i) => i.id !== itemId));
}

export function addItem(draft: ProfileDraft, fields: { group: Group; title: string; text: string }): ProfileDraft {
  return withItems(draft, [...draft.items, makeItem(fields)]);
}

/** "Save to memory": files every item still in the draft. */
export function saveProfile(store: MemoryStore, draft: ProfileDraft): Promise<AddResult> {
  return store.addFacts(draft.items.map((i) => ({ category: i.category, title: i.title, text: i.text })), "setup");
}
