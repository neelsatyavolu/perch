import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi, WIPE_CONFIRMATION } from "../src/memory/api";
import { mockKeychain } from "../src/memory/keychain";
import { MemoryStore } from "../src/memory/store";
import { fakeModel } from "../src/models/fake";
import type { TurnEvent } from "../src/models/types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const now = new Date("2026-11-05T10:00:00Z");

async function api(script: TurnEvent[][] = []) {
  const dir = mkdtempSync(join(tmpdir(), "perch-memapi-"));
  dirs.push(dir);
  const store = await MemoryStore.open({ dir, keys: mockKeychain(), profile: "default", now: () => now });
  const historyCalls: string[] = [];
  const model = fakeModel(script);
  const a = createMemoryApi({
    store,
    model: async () => model,
    now: () => now,
    setupInputs: () => ({ history: async () => (historyCalls.push("history"), []), tabs: async () => (historyCalls.push("tabs"), []) }),
  });
  return { a, store, model, historyCalls };
}

const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

test("Overview: add, list, read, edit and delete facts and pages", async () => {
  const { a } = await api();
  ok(await a.addFact({ category: "people", title: "Maya Chen", text: "Sister" }));
  ok(await a.addFact({ category: "user", text: "Likes tea" }));
  const pages = ok(await a.listPages());
  expect(pages.map((p) => p.path)).toEqual(["USER.md", "people/maya-chen.md"]);
  expect(ok(await a.listPages({ category: "people" })).map((p) => p.path)).toEqual(["people/maya-chen.md"]);
  const maya = pages[1]!;
  expect(ok(await a.getPage({ id: maya.id })).current[0]!.text).toBe("Sister");
  expect(ok(await a.editFact({ pageId: maya.id, index: 0, text: "Older sister" })).current[0]!.text).toBe("Older sister");
  expect(ok(await a.search({ query: "older" })).map((h) => h.path)).toEqual(["people/maya-chen.md"]);
  expect(ok(await a.deleteFact({ pageId: maya.id, index: 0 })).current).toEqual([]);
  ok(await a.deletePage({ id: maya.id }));
  expect(await a.getPage({ id: maya.id })).toEqual({ ok: false, error: "This memory page no longer exists." });
  expect(ok(await a.changes()).map((c) => c.action)).toEqual(["delete", "delete", "edit", "add", "add"]);
});

test("bad input gets plain errors and changes nothing", async () => {
  const { a, store } = await api();
  expect(await a.addFact(null)).toEqual({ ok: false, error: "Expected an object." });
  expect(await a.addFact({ category: "log", text: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("category must be one of") });
  expect(await a.addFact({ category: "user", text: "x".repeat(501) })).toMatchObject({ ok: false, error: "text is too long (at most 500 characters)." });
  expect(await a.addFact({ category: "user", text: "my pin is 1234" })).toEqual({ ok: false, error: "Not saved: looks like a secret." });
  expect(await a.getPage({ id: "../../etc" })).toEqual({ ok: false, error: "id is not a valid id." });
  expect(await a.editFact({ pageId: "a".repeat(32), index: -1, text: "x" })).toMatchObject({ ok: false });
  expect(await a.search({ query: 7 })).toEqual({ ok: false, error: "query must be text." });
  expect(store.list()).toEqual([]);
});

test("Configure: settings are checked; wipe needs the typed confirmation", async () => {
  const { a, store } = await api();
  expect(ok(await a.updateSettings({ paused: true, episodicRetentionDays: 90 }))).toEqual({ extraction: true, paused: true, dreaming: true, episodicRetentionDays: 90 });
  expect(await a.updateSettings({ paused: "yes" })).toEqual({ ok: false, error: "paused must be true or false." });
  expect(await a.updateSettings({ episodicRetentionDays: 7 })).toMatchObject({ ok: false });
  ok(await a.addFact({ category: "user", text: "Likes tea" }));
  expect(await a.wipe({ confirm: "yes" })).toEqual({ ok: false, error: `Type "${WIPE_CONFIRMATION}" to confirm.` });
  expect(store.list()).toHaveLength(1);
  ok(await a.wipe({ confirm: WIPE_CONFIRMATION }));
  expect(store.list()).toEqual([]);
  expect(ok(await a.status())).toMatchObject({ pages: 0, damaged: 0 });
});

test("Set up your memory: switches decide what is read, the draft is editable, and only Save files it", async () => {
  const propose: TurnEvent[] = [
    { type: "tool_call", call: { id: "p", name: "propose_profile", args: { items: [{ group: "about", title: "You", text: "Name is Neel" }, { group: "people", title: "Maya", text: "Sister" }] } } },
    { type: "done" },
  ];
  const { a, store, historyCalls } = await api([propose]);
  expect(a.setupOptions().defaults.webSearch).toBe(false);
  expect(await a.startSetup({ sources: { history: false, tabs: false, bookmarks: false, chats: false, questionnaire: false } })).toEqual({ ok: false, error: "Turn on at least one source." });
  let draft = ok(await a.startSetup({ sources: { history: false, tabs: true, webSearch: true, questionnaire: true }, answers: { name: "Neel" } }));
  expect(historyCalls).toEqual(["tabs"]);
  expect(draft.sources).toEqual(["tabs", "questionnaire"]);
  expect(store.list()).toEqual([]);
  const [, maya] = draft.items;
  draft = ok(await a.editSetupItem({ draftId: draft.id, itemId: maya!.id, title: "Maya Chen" }));
  draft = ok(await a.addSetupItem({ draftId: draft.id, group: "writing", title: "Email", text: "Short replies" }));
  draft = ok(await a.removeSetupItem({ draftId: draft.id, itemId: draft.items[0]!.id }));
  expect(await a.editSetupItem({ draftId: draft.id, itemId: maya!.id, text: "password: hunter22" })).toMatchObject({ ok: false, error: expect.stringContaining("secret") });
  expect(ok(await a.saveSetup({ draftId: draft.id }))).toMatchObject({ added: 2 });
  expect(store.list().map((p) => p.path)).toEqual(["people/maya-chen.md", "writing/email.md"]);
  expect(await a.saveSetup({ draftId: draft.id })).toEqual({ ok: false, error: "This draft is gone. Start setup again." });
});

test("dreamNow runs consolidation with the model", async () => {
  const { a } = await api([[{ type: "tool_call", call: { id: "d", name: "consolidate", args: {} } }, { type: "done" }]]);
  ok(await a.addFact({ category: "user", text: "Likes tea" }));
  expect(ok(await a.dreamNow())).toMatchObject({ date: "2026-11-05", merged: 0 });
});
