/**
 * Typed functions for the Memory page (Overview, History, Configure, and "Set up your memory").
 * Each takes untrusted input from WebUI, checks it, and returns { ok, data } or { ok, error }.
 * Setup drafts live only in this process's memory until saveSetup files them.
 */

import type { Model } from "../models/types";
import { attempt, flag, id, int, oneOf, record, text, type ApiResult } from "./api-input";
import { dream, type DreamReport } from "./dream";
import type { Page } from "./page";
import { CATEGORIES, FILEABLE, MAX_FACT, MAX_TITLE, type Category } from "./sanitize";
import type { SearchHit } from "./search";
import { addItem, buildProfile, DEFAULT_SOURCES, editItem, GROUPS, QUESTIONS, removeItem, saveProfile, SOURCES, type Group, type ProfileDraft, type SetupInputs, type SetupSources, type SourceId } from "./setup";
import type { AddResult, Change, MemorySettings, MemoryStore, PageSummary } from "./store";
import { MAX_TAXONOMY, TAXONOMY_PATH } from "./taxonomy";

export type TaxonomyView = { path: string; text: string; custom: boolean };

export type MemoryApiDeps = { store: MemoryStore; model: () => Promise<Model>; setupInputs: () => SetupInputs; now?: () => Date };
export const WIPE_CONFIRMATION = "delete all memory";
const MAX_DRAFTS = 4;

export function createMemoryApi(deps: MemoryApiDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const drafts = new Map<string, ProfileDraft>();
  const draftOf = (input: Record<string, unknown>) => {
    const draft = drafts.get(id(input, "draftId"));
    if (!draft) throw new Error("This draft is gone. Start setup again.");
    return draft;
  };
  const keep = (draft: ProfileDraft) => {
    drafts.set(draft.id, draft);
    return draft;
  };
  const pageOf = (input: Record<string, unknown>, key = "pageId"): Page => {
    const page = store.get(id(input, key));
    if (!page) throw new Error("This memory page no longer exists.");
    return page;
  };
  const taxonomyView = (): TaxonomyView => ({ path: TAXONOMY_PATH, text: store.taxonomy(), custom: store.isTaxonomyCustom() });
  const factRef = (input: Record<string, unknown>) => {
    const page = pageOf(input);
    const section = oneOf(input, "section", ["current", "history"] as const, "current");
    return { page, section, index: int(input, "index", { min: 0, max: 1000 }) };
  };

  return {
    status: (): Promise<ApiResult<{ pages: number; damaged: number; settings: MemorySettings }>> =>
      attempt(() => ({ pages: store.list().length, damaged: store.damaged.length, settings: store.settings() })),

    listPages: (input: unknown = {}): Promise<ApiResult<PageSummary[]>> =>
      attempt(() => {
        const category = record(input).category;
        if (category === undefined) return store.list();
        const wanted = oneOf(record(input), "category", CATEGORIES);
        return store.list().filter((p) => p.category === wanted);
      }),

    getPage: (input: unknown): Promise<ApiResult<Page>> => attempt(() => pageOf(record(input), "id")),

    search: (input: unknown): Promise<ApiResult<SearchHit[]>> =>
      attempt(async () => {
        const i = record(input);
        return store.search(text(i, "query", { max: 500 }), { limit: int(i, "limit", { min: 1, max: 50, fallback: 20 }) });
      }),

    addFact: (input: unknown): Promise<ApiResult<AddResult>> =>
      attempt(async () => {
        const i = record(input);
        const category = oneOf(i, "category", FILEABLE) as Category;
        const fact = { category, title: text(i, "title", { max: MAX_TITLE, optional: true }), text: text(i, "text", { max: MAX_FACT }), expires: text(i, "expires", { max: 10, optional: true }) || undefined };
        const result = await store.addFacts([fact], "user");
        if (result.rejected[0]) throw new Error(`Not saved: ${result.rejected[0].reason}.`);
        return result;
      }),

    editFact: (input: unknown): Promise<ApiResult<Page>> =>
      attempt(() => {
        const i = record(input);
        const ref = factRef(i);
        return store.editFact(ref.page.id, ref.section, ref.index, text(i, "text", { max: MAX_FACT }));
      }),

    deleteFact: (input: unknown): Promise<ApiResult<Page>> =>
      attempt(() => {
        const ref = factRef(record(input));
        return store.editFact(ref.page.id, ref.section, ref.index, null);
      }),

    deletePage: (input: unknown): Promise<ApiResult<null>> => attempt(async () => (await store.deletePage(pageOf(record(input), "id").id), null)),

    wipe: (input: unknown): Promise<ApiResult<null>> =>
      attempt(async () => {
        if (record(input).confirm !== WIPE_CONFIRMATION) throw new Error(`Type "${WIPE_CONFIRMATION}" to confirm.`);
        await store.wipe();
        drafts.clear();
        return null;
      }),

    getSettings: (): Promise<ApiResult<MemorySettings>> => attempt(() => store.settings()),

    updateSettings: (input: unknown): Promise<ApiResult<MemorySettings>> =>
      attempt(() => {
        const i = record(input);
        const patch: Partial<MemorySettings> = {};
        for (const key of ["extraction", "paused", "dreaming"] as const) {
          const value = flag(i, key);
          if (value !== undefined) patch[key] = value;
        }
        if ("episodicRetentionDays" in i) {
          const days = i.episodicRetentionDays;
          if (days !== null && days !== 30 && days !== 90) throw new Error("Keep episodic memories for 30 days, 90 days, or never forget (null).");
          patch.episodicRetentionDays = days;
        }
        return store.updateSettings(patch);
      }),

    getTaxonomy: (): Promise<ApiResult<TaxonomyView>> => attempt(() => taxonomyView()),

    setTaxonomy: (input: unknown): Promise<ApiResult<TaxonomyView>> =>
      attempt(async () => (await store.setTaxonomy(text(record(input), "text", { max: MAX_TAXONOMY, label: "TAXONOMY.md" })), taxonomyView())),

    resetTaxonomy: (): Promise<ApiResult<TaxonomyView>> => attempt(async () => (await store.setTaxonomy(null), taxonomyView())),

    changes: (input: unknown = {}): Promise<ApiResult<Change[]>> => attempt(() => store.changes(int(record(input), "limit", { min: 1, max: 1000, fallback: 200 }))),

    dreamNow: (): Promise<ApiResult<DreamReport>> => attempt(async () => dream({ store, model: await deps.model(), now: now() })),

    setupOptions: () => ({ sources: SOURCES, defaults: DEFAULT_SOURCES, questions: QUESTIONS, groups: GROUPS.map(({ id, label }) => ({ id, label })) }),

    startSetup: (input: unknown): Promise<ApiResult<ProfileDraft>> =>
      attempt(async () => {
        const i = record(input);
        const chosen = record(i.sources ?? DEFAULT_SOURCES);
        const sources = Object.fromEntries(SOURCES.map((s) => [s.id, s.available && flag(chosen, s.id) === true])) as SetupSources;
        if (!Object.values(sources).some(Boolean)) throw new Error("Turn on at least one source.");
        const rawAnswers = record(i.answers ?? {});
        const answers = Object.fromEntries(QUESTIONS.map((q) => [q.id, text(rawAnswers, q.id, { max: 500, optional: true, label: q.text })]));
        const result = await buildProfile({ model: await deps.model(), sources, inputs: { ...deps.setupInputs(), answers }, now: now(), taxonomy: store.taxonomy() });
        if ("error" in result) throw new Error(result.error);
        if (drafts.size >= MAX_DRAFTS) drafts.delete(drafts.keys().next().value!);
        return keep(result.draft);
      }),

    editSetupItem: (input: unknown): Promise<ApiResult<ProfileDraft>> =>
      attempt(() => {
        const i = record(input);
        const group = i.group === undefined ? undefined : oneOf(i, "group", GROUPS.map((g) => g.id) as Group[]);
        const title = i.title === undefined ? undefined : text(i, "title", { max: MAX_TITLE });
        const body = i.text === undefined ? undefined : text(i, "text", { max: MAX_FACT });
        return keep(editItem(draftOf(i), id(i, "itemId"), { group, title, text: body }));
      }),

    removeSetupItem: (input: unknown): Promise<ApiResult<ProfileDraft>> =>
      attempt(() => {
        const i = record(input);
        return keep(removeItem(draftOf(i), id(i, "itemId")));
      }),

    addSetupItem: (input: unknown): Promise<ApiResult<ProfileDraft>> =>
      attempt(() => {
        const i = record(input);
        const group = oneOf(i, "group", GROUPS.map((g) => g.id) as Group[]);
        return keep(addItem(draftOf(i), { group, title: text(i, "title", { max: MAX_TITLE, optional: true }), text: text(i, "text", { max: MAX_FACT }) }));
      }),

    saveSetup: (input: unknown): Promise<ApiResult<AddResult>> =>
      attempt(async () => {
        const draft = draftOf(record(input));
        const result = await saveProfile(store, draft);
        drafts.delete(draft.id);
        return result;
      }),

    discardSetup: (input: unknown): Promise<ApiResult<null>> => attempt(() => (drafts.delete(draftOf(record(input)).id), null)),
  };
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
export type { SourceId };
