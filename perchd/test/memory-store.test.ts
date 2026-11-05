import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockKeychain, type KeyStore } from "../src/memory/keychain";
import { ftsQuery, fuse, type Embedder } from "../src/memory/search";
import { MemoryStore } from "../src/memory/store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let clock = new Date("2026-11-05T10:00:00Z");
async function open(opts: { keys?: KeyStore; dir?: string; embedder?: Embedder } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "perch-store-"));
  if (!opts.dir) dirs.push(dir);
  const store = await MemoryStore.open({ dir, keys: opts.keys ?? mockKeychain(), profile: "default", now: () => clock, embedder: opts.embedder });
  return { store, dir };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

test("ftsQuery quotes every word, drops filler and survives FTS syntax", () => {
  expect(ftsQuery("Where does Maya work?")).toBe('"maya"* OR "work"*');
  expect(ftsQuery('a "b" OR NEAR(c) -d *')).toBeNull();
  expect(ftsQuery("C++ AND github.com")).toBe('"github"* OR "com"*');
});

test("facts are filed into pages, duplicates are skipped, secrets are refused", async () => {
  const { store } = await open();
  const result = await store.addFacts(
    [
      { category: "people", title: "Maya Chen", text: "Designer at Chen Studio" },
      { category: "people", title: "Maya Chen", text: "designer at chen studio." },
      { category: "user", title: "About you", text: "Prefers aisle seats" },
      { category: "sites", title: "github.com", text: "My GitHub password is hunter22" },
      { category: "log" as any, title: "x", text: "not fileable" },
    ],
    "chat",
  );
  expect(result).toEqual({ added: 2, duplicates: 1, rejected: [{ text: "My GitHub password is hunter22", reason: "looks like a secret" }, { text: "not fileable", reason: "unknown category" }], paths: ["people/maya-chen.md", "USER.md"] });
  expect(store.list().map((p) => [p.path, p.facts])).toEqual([
    ["USER.md", 1],
    ["people/maya-chen.md", 1],
  ]);
  expect(store.get("people/maya-chen.md")!.current[0]).toMatchObject({ text: "Designer at Chen Studio", source: "chat", added: clock.toISOString() });
});

test("search ranks the best page first, by title, facts and prefixes, with a category filter", async () => {
  const { store } = await open();
  await store.addFacts(
    [
      { category: "people", title: "Maya Chen", text: "Designer at Chen Studio in Lisbon" },
      { category: "places", title: "Lisbon", text: "Flat in Alfama, rented through Airbnb" },
      { category: "sites", title: "airbnb.com", text: "Uses Airbnb for trips longer than a week" },
    ],
    "chat",
  );
  const hits = await store.search("Maya's studio");
  expect(hits[0]).toMatchObject({ path: "people/maya-chen.md", title: "Maya Chen" });
  expect(hits[0]!.snippet).toContain("Studio");
  expect((await store.search("airb")).map((h) => h.path).sort()).toEqual(["places/lisbon.md", "sites/airbnb-com.md"]);
  expect((await store.search("airbnb", { categories: ["sites"] })).map((h) => h.path)).toEqual(["sites/airbnb-com.md"]);
  expect(await store.search("")).toEqual([]);
});

test("search follows edits and deletes", async () => {
  const { store } = await open();
  await store.addFacts([{ category: "projects", title: "Perch", text: "Chromium fork browser" }], "chat");
  const page = store.get("projects/perch.md")!;
  await store.editFact(page.id, "current", 0, "An open source browser built on Chromium");
  expect((await store.search("fork")).length).toBe(0);
  expect((await store.search("open source")).map((h) => h.path)).toEqual(["projects/perch.md"]);
  await store.deletePage(page.id);
  expect(await store.search("browser")).toEqual([]);
  expect(store.get(page.id)).toBeNull();
});

test("editing a fact to empty deletes it; bad indexes and secrets are refused", async () => {
  const { store } = await open();
  await store.addFacts([{ category: "user", title: "You", text: "Lives in Palo Alto" }, { category: "user", title: "You", text: "Plays tennis" }], "chat");
  const id = store.get("USER.md")!.id;
  await store.editFact(id, "current", 0, null);
  expect(store.get(id)!.current.map((f) => f.text)).toEqual(["Plays tennis"]);
  await expect(store.editFact(id, "current", 5, "x")).rejects.toThrow("no fact");
  await expect(store.editFact(id, "current", 0, "pin: 1234")).rejects.toThrow("secret");
  expect(store.get(id)!.current[0]!.source).toBe("chat");
});

test("everything survives a reopen with the same key, and nothing is plaintext on disk", async () => {
  const keys = mockKeychain();
  const { store, dir } = await open({ keys });
  await store.addFacts([{ category: "people", title: "Zebulon Quixote", text: "CANARYFACT lives on Vesuvius Street" }], "setup");
  await store.updateSettings({ paused: true });
  const again = await MemoryStore.open({ dir, keys, profile: "default", now: () => clock });
  expect(again.get("people/zebulon-quixote.md")!.current[0]!.text).toBe("CANARYFACT lives on Vesuvius Street");
  expect(again.settings().paused).toBe(true);
  expect((await again.search("vesuvius")).length).toBe(1);
  const files = walk(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    expect(f).not.toMatch(/zebulon|quixote|\.db|\.sqlite|-wal|-shm/i);
    const bytes = readFileSync(f);
    for (const word of ["CANARYFACT", "Vesuvius", "Zebulon", "zebulon-quixote", "people/"]) expect(bytes.includes(Buffer.from(word))).toBe(false);
  }
});

test("USER.md and MEMORY.md make the chat context; recall adds the best matching pages", async () => {
  const { store } = await open();
  await store.addFacts(
    [
      { category: "user", title: "You", text: "Name is Neel" },
      { category: "rules", title: "Rules", text: "Never book flights with Spirit" },
      { category: "people", title: "Maya Chen", text: "Sister, lives in Lisbon" },
    ],
    "setup",
  );
  expect(store.context()).toBe("About the user (USER.md):\n- Name is Neel\n\nRules from the user (MEMORY.md):\n- Never book flights with Spirit");
  const recalled = await store.recall("Send Maya a birthday card");
  expect(recalled).toContain("people/maya-chen.md");
  expect(recalled).toContain("Sister, lives in Lisbon");
  expect(await store.recall("unrelated topic xyz")).toBe("");
});

test("every change is logged, and wipe removes everything", async () => {
  const { store, dir } = await open();
  await store.addFacts([{ category: "user", title: "You", text: "Likes tea" }], "chat");
  await store.editFact(store.get("USER.md")!.id, "current", 0, "Likes green tea");
  const log = await store.changes();
  expect(log.map((c) => c.action)).toEqual(["edit", "add"]);
  expect(log[1]).toMatchObject({ path: "USER.md", detail: "Likes tea", source: "chat" });
  await store.wipe();
  expect(store.list()).toEqual([]);
  expect(await store.changes()).toEqual([{ time: clock.toISOString(), action: "wipe", path: "", detail: "All memory was deleted", source: "user" }]);
  expect(walk(dir).filter((f) => f.includes("/pages/"))).toEqual([]);
});

test("episodic facts go into a page for the day", async () => {
  const { store } = await open();
  await store.addFacts([{ category: "episodic", title: "anything", text: "Booked the dentist for Nov 12" }], "chat");
  expect(store.list().map((p) => p.path)).toEqual(["episodic/2026-11-05.md"]);
});

test("settings are validated", async () => {
  const { store } = await open();
  expect(store.settings()).toEqual({ extraction: true, paused: false, historyExtraction: false, episodicRetentionDays: null });
  await expect(store.updateSettings({ episodicRetentionDays: 12 as any })).rejects.toThrow("30, 90");
  await store.updateSettings({ episodicRetentionDays: 30 });
  expect(store.settings().episodicRetentionDays).toBe(30);
});

test("fuse blends keyword and vector ranks; an embedder can lift a page with no shared words", async () => {
  expect(fuse([["a", "b"], ["b", "c"]])).toEqual(["b", "a", "c"]);
  const embedder: Embedder = {
    id: "fake",
    async embed(texts) {
      return texts.map((t) => new Float32Array([/sibling|sister/i.test(t) ? 1 : 0, /tea/i.test(t) ? 1 : 0, 0.01]));
    },
  };
  const { store } = await open({ embedder });
  await store.addFacts([{ category: "people", title: "Maya Chen", text: "Sister in Lisbon" }, { category: "concepts", title: "Tea", text: "Likes green tea" }], "chat");
  expect((await store.search("sibling")).map((h) => h.path)).toEqual(["people/maya-chen.md"]);
});
