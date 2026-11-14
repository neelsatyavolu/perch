/**
 * The Import page's writer for Aside's agent data (the `agent` hook of src/import/apply.ts):
 * memory pages go into the memory store, skills into the skill store, chats into the chat store.
 * Importing again adds nothing twice:
 *
 *   memory   a page whose path Perch already has is kept as Perch has it, and the import is skipped
 *   skills   a skill whose name is already installed is skipped
 *   chats    a chat's id comes from Aside's id, so a chat already imported is skipped
 */

import type { AgentCounts, AgentWriter } from "../../import/apply";
import type { Chat as AsideChat, TextFile } from "../../import/types";
import { memoryAllowed } from "../../policy/policy";
import { policyOf } from "./common";
import type { PagesDeps } from "./deps";
import { chatFromAside } from "./import-chats";
import { pagesFromAside } from "./import-memory";
import { skillsFromAside } from "./import-skills";

export const ASIDE_SOURCE = "Aside";
export const MEMORY_DETAIL = "Imported from Aside";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The pages every chat reads; facts merge into them rather than skip a page Perch already has. */
const TOP: Readonly<Record<string, "user" | "rules">> = { "USER.md": "user", "MEMORY.md": "rules" };

async function writeMemory(deps: PagesDeps, files: readonly TextFile[]): Promise<AgentCounts> {
  const store = (await deps.data()).memory;
  const mapped = files.map(pagesFromAside);
  const pages = mapped.flatMap((m) => m?.pages ?? []);
  // USER.md and MEMORY.md often exist already (a chat saved a fact before the import), and Aside's
  // own profile (users/<name>.md) lands on USER.md too: their facts join the page.
  const mergedFile = new Set<number>();
  for (const [i, m] of mapped.entries()) {
    for (const page of (m?.pages ?? []).filter((p) => TOP[p.path])) {
      const result = await store.addFacts(page.current.map((text) => ({ category: TOP[page.path]!, title: page.title, text })), "import");
      if (result.added) mergedFile.add(i);
    }
  }
  const result = await store.addPages(pages.filter((p) => !TOP[p.path]), "import", MEMORY_DETAIL);
  // A file counts as imported when its first page went in; its continuation pages are part of it.
  // Two files that land on one page path count once: the store kept the first.
  const added = new Set(result.added);
  const paged = [...new Set(mapped.flatMap((m) => (m?.pages[0] && !TOP[m.pages[0].path] ? [m.pages[0].path] : [])))].filter((path) => added.has(path)).length;
  const written = paged + mergedFile.size;
  const secrets = mapped.reduce((n, m) => n + (m?.secrets ?? 0), 0);
  const note = secrets ? `${plural(secrets, "line that looked", "lines that looked")} like a password, key or code ${secrets === 1 ? "was" : "were"} left out.` : undefined;
  return { added: written, skipped: files.length - written, ...(note ? { note } : {}) };
}

async function writeSkills(deps: PagesDeps, files: readonly TextFile[]): Promise<AgentCounts> {
  const { store } = deps.skills;
  const { bundles, unreadable } = skillsFromAside(files);
  const installed = new Set(await store.names());
  const fresh = [...new Map(bundles.map((b) => [b.name, b])).values()].filter((b) => !installed.has(b.name));
  for (const bundle of fresh) await store.install(bundle, ASIDE_SOURCE);
  return { added: fresh.length, skipped: bundles.length - fresh.length + unreadable };
}

async function writeChats(deps: PagesDeps, chats: readonly AsideChat[]): Promise<AgentCounts> {
  const now = (deps.now?.() ?? new Date()).getTime();
  const mapped = chats.flatMap((c) => chatFromAside(c, now) ?? []);
  const added = await deps.chats.addAll(mapped);
  return { added: added.length, skipped: chats.length - added.length };
}

/** Memory is left to the bundle when the company has turned memory off. */
export function agentWriter(deps: PagesDeps): AgentWriter {
  return {
    ...(memoryAllowed(policyOf(deps)) ? { memory: (files: readonly TextFile[]) => writeMemory(deps, files) } : {}),
    skills: (files) => writeSkills(deps, files),
    chats: (chats) => writeChats(deps, chats),
  };
}
