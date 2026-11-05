import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatMemory } from "../src/memory/agent";
import { createMemoryApi } from "../src/memory/api";
import { extractFromChat } from "../src/memory/extract";
import { mockKeychain } from "../src/memory/keychain";
import { MemoryStore } from "../src/memory/store";
import { DEFAULT_TAXONOMY } from "../src/memory/taxonomy";
import { fakeModel } from "../src/models/fake";
import type { TurnEvent } from "../src/models/types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const now = new Date("2026-11-05T10:00:00Z");
const keys = mockKeychain();
const CUSTOM = "Where facts go:\n- people: one page per person.\n- CANARYRULE: file teachers under people, titled with their surname.";

async function open(dir = mkdtempSync(join(tmpdir(), "perch-taxonomy-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = await MemoryStore.open({ dir, keys, profile: "default", now: () => now });
  const model = fakeModel([[{ type: "tool_call", call: { id: "p", name: "propose_profile", args: { items: [] } } }, { type: "done" }]]);
  const api = createMemoryApi({ store, model: async () => model, now: () => now, setupInputs: () => ({}) });
  return { dir, store, api, model };
}
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

test("TAXONOMY.md starts as the default filing rules and the user can read, change and reset it", async () => {
  const { api, store } = await open();
  expect(ok(await api.getTaxonomy())).toEqual({ path: "TAXONOMY.md", text: DEFAULT_TAXONOMY, custom: false });
  expect(ok(await api.setTaxonomy({ text: `  ${CUSTOM}  ` }))).toEqual({ path: "TAXONOMY.md", text: CUSTOM, custom: true });
  expect(store.taxonomy()).toBe(CUSTOM);
  expect((await store.changes())[0]).toMatchObject({ action: "edit", path: "TAXONOMY.md", source: "user" });
  expect(await api.setTaxonomy({ text: "" })).toMatchObject({ ok: false });
  expect(await api.setTaxonomy({ text: "x".repeat(4001) })).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
  expect(ok(await api.resetTaxonomy())).toEqual({ path: "TAXONOMY.md", text: DEFAULT_TAXONOMY, custom: false });
});

test("a changed TAXONOMY.md is encrypted on disk, survives a reopen and survives wiping memory", async () => {
  const { api, dir, store } = await open();
  ok(await api.setTaxonomy({ text: CUSTOM }));
  for (const f of walk(dir)) expect(readFileSync(f).includes(Buffer.from("CANARYRULE"))).toBe(false);
  await store.wipe();
  expect((await open(dir)).store.taxonomy()).toBe(CUSTOM);
});

test("extraction, setup and memory_save all file by the user's TAXONOMY.md", async () => {
  const { api, store, model } = await open();
  ok(await api.setTaxonomy({ text: CUSTOM }));
  expect(chatMemory(store)!.specs.find((s) => s.name === "memory_save")!.description).toContain("CANARYRULE");
  ok(await api.startSetup({ sources: { questionnaire: true }, answers: { work: "Teacher" } }));
  expect(model.requests[0]!.system).toContain("CANARYRULE");
  const extractor = fakeModel([[{ type: "tool_call", call: { id: "f", name: "file_memories", args: { facts: [] } } }, { type: "done" }] as TurnEvent[]]);
  await extractFromChat({ model: extractor, store, transcript: [{ role: "user", text: "My physics teacher is Ms Lee" }] });
  expect(extractor.requests[0]!.system).toContain("CANARYRULE");
});
