import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockKeychain } from "../src/memory/keychain";
import { addItem, buildProfile, DEFAULT_SOURCES, editItem, QUESTIONS, removeItem, saveProfile, SOURCES, type SetupInputs } from "../src/memory/setup";
import { readChromiumBookmarks, readChromiumHistory, summarizeHistory } from "../src/memory/sources";
import { MemoryStore } from "../src/memory/store";
import { fakeModel } from "../src/models/fake";
import type { TurnEvent } from "../src/models/types";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "perch-setup-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const now = new Date("2026-11-05T10:00:00Z");
const chromeTime = (d: Date) => BigInt(d.getTime() + 11_644_473_600_000) * 1000n;

function historyFixture(dir: string): void {
  const db = new Database(join(dir, "History"));
  db.run("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)");
  const add = db.prepare("INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, 0, ?, 0)");
  add.run("https://github.com/neel/perch?tab=readme&token=abc", "neel/perch: a browser", 40, chromeTime(new Date("2026-11-04")));
  add.run("https://github.com/notifications", "Notifications", 12, chromeTime(new Date("2026-11-03")));
  add.run("https://canvas.paly.net/courses/1", "AP Physics C", 25, chromeTime(new Date("2026-11-01")));
  add.run("https://old.example.com/", "Old site", 99, chromeTime(new Date("2025-01-01")));
  add.run("http://localhost:3000/", "dev server", 50, chromeTime(new Date("2026-11-04")));
  db.close();
}

test("history is read without locking Chrome's file, limited to recent visits, and reduced to domains without query strings", async () => {
  const dir = temp();
  historyFixture(dir);
  const rows = await readChromiumHistory(dir, { now, days: 90 });
  expect(rows.map((r) => r.url)).toEqual(["https://github.com/neel/perch", "https://canvas.paly.net/courses/1", "https://github.com/notifications"]);
  const summary = summarizeHistory(rows);
  expect(summary).toContain("github.com: 52 visits (neel/perch: a browser; Notifications)");
  expect(summary).not.toContain("token=abc");
  expect(await readChromiumHistory(join(dir, "missing"), { now })).toEqual([]);
});

test("bookmarks are read with their folders", async () => {
  const dir = temp();
  writeFileSync(
    join(dir, "Bookmarks"),
    JSON.stringify({ roots: { bookmark_bar: { type: "folder", name: "Bookmarks bar", children: [{ type: "folder", name: "School", children: [{ type: "url", name: "Canvas", url: "https://canvas.paly.net/" }] }, { type: "url", name: "Mail", url: "https://mail.google.com/" }] }, other: { type: "folder", name: "Other", children: [] } } }),
  );
  expect(await readChromiumBookmarks(dir)).toEqual([
    { title: "Canvas", url: "https://canvas.paly.net/", folder: "Bookmarks bar/School" },
    { title: "Mail", url: "https://mail.google.com/", folder: "Bookmarks bar" },
  ]);
  expect(await readChromiumBookmarks(join(dir, "nope"))).toEqual([]);
});

test("the source list has switches; web search and unbuilt sources start off", () => {
  expect(DEFAULT_SOURCES).toEqual({ history: true, bookmarks: true, tabs: true, chats: true, questionnaire: true, webSearch: false });
  expect(SOURCES.find((s) => s.id === "webSearch")).toMatchObject({ available: false });
  expect(SOURCES.find((s) => s.id === "history")).toMatchObject({ available: true, label: "Browsing history" });
  expect(QUESTIONS.length).toBeGreaterThanOrEqual(4);
});

const propose = (items: unknown[]): TurnEvent[] => [{ type: "tool_call", call: { id: "p", name: "propose_profile", args: { items } } }, { type: "done" }];

function inputs(calls: string[]): SetupInputs {
  return {
    history: async () => (calls.push("history"), [{ url: "https://canvas.paly.net/courses/1", title: "AP Physics C", visits: 25, lastVisit: "2026-11-01T00:00:00.000Z" }]),
    bookmarks: async () => (calls.push("bookmarks"), []),
    tabs: async () => (calls.push("tabs"), [{ id: "t1", title: "Gmail", url: "https://mail.google.com/mail/u/0/#inbox" }]),
    chats: async () => (calls.push("chats"), [{ title: "Dinner", firstMessage: "Book dinner with Maya", date: "2026-11-01" }]),
    answers: { name: "Neel", writing: "Short and plain" },
  };
}

test("only switched-on sources are read; the draft is grouped, cleaned of secrets, and nothing is saved yet", async () => {
  const calls: string[] = [];
  const model = fakeModel([
    propose([
      { group: "about", title: "You", text: "Name is Neel", sources: ["questionnaire"] },
      { group: "about", title: "You", text: "Studies AP Physics C at Palo Alto High", sources: ["history"] },
      { group: "people", title: "Maya", text: "Has dinner with Neel", sources: ["chats"] },
      { group: "sites", title: "canvas.paly.net", text: "School courses on Canvas", sources: ["history"] },
      { group: "sites", title: "bank", text: "Bank password: hunter22", sources: ["tabs"] },
      { group: "nonsense", title: "x", text: "dropped" },
    ]),
  ]);
  const s = await MemoryStore.open({ dir: temp(), keys: mockKeychain(), profile: "default", now: () => now });
  const result = await buildProfile({ model, sources: { ...DEFAULT_SOURCES, tabs: false }, inputs: inputs(calls), now });
  if ("error" in result) throw new Error(result.error);
  const { draft } = result;
  expect(calls.sort()).toEqual(["bookmarks", "chats", "history"]);
  const prompt = model.requests[0]!.messages[0]!.role === "user" ? model.requests[0]!.messages[0]!.text : "";
  expect(prompt).toContain("canvas.paly.net");
  expect(prompt).toContain("Q: What should Perch call you?\nA: Neel");
  expect(prompt).not.toContain("mail.google.com");
  expect(draft.items.map((i) => [i.group, i.category, i.text])).toEqual([
    ["about", "user", "Name is Neel"],
    ["about", "user", "Studies AP Physics C at Palo Alto High"],
    ["people", "people", "Has dinner with Neel"],
    ["sites", "sites", "School courses on Canvas"],
  ]);
  expect(draft.gaps).toEqual(["places", "writing"]);
  expect(s.list()).toEqual([]);
});

test("every item can be edited, removed or added before saving, and saving files them all", async () => {
  const model = fakeModel([propose([{ group: "about", title: "You", text: "Name is Neel" }, { group: "people", title: "Maya", text: "Sister" }])]);
  const result = await buildProfile({ model, sources: DEFAULT_SOURCES, inputs: { answers: {} }, now });
  if ("error" in result) throw new Error(result.error);
  let draft = result.draft;
  const [name, maya] = draft.items;
  draft = editItem(draft, maya!.id, { title: "Maya Chen", text: "Older sister" });
  draft = removeItem(draft, name!.id);
  draft = addItem(draft, { group: "writing", title: "Email", text: "Signs off with -N" });
  expect(() => editItem(draft, maya!.id, { text: "pin is 4455" })).toThrow("secret");
  expect(() => editItem(draft, "missing", { text: "x" })).toThrow("no such item");
  expect(() => addItem(draft, { group: "bogus" as any, title: "x", text: "y" })).toThrow("group");
  expect(result.draft.items).toHaveLength(2);
  const s = await MemoryStore.open({ dir: temp(), keys: mockKeychain(), profile: "default", now: () => now });
  expect(await saveProfile(s, draft)).toMatchObject({ added: 2 });
  expect(s.get("people/maya-chen.md")!.current[0]).toMatchObject({ text: "Older sister", source: "setup" });
  expect(s.get("writing/email.md")!.current[0]!.text).toBe("Signs off with -N");
  expect(s.get("USER.md")).toBeNull();
});

test("a model that fails or does not answer gives a plain error", async () => {
  const failing = { id: "x", async *turn(): AsyncIterable<TurnEvent> { throw new Error("signed out"); } };
  expect(await buildProfile({ model: failing, sources: DEFAULT_SOURCES, inputs: {}, now })).toEqual({ error: "signed out" });
  const silent = fakeModel([[{ type: "text", delta: "hmm" }, { type: "done" }]]);
  expect(await buildProfile({ model: silent, sources: DEFAULT_SOURCES, inputs: {}, now })).toEqual({ error: "The model did not return a profile. Try again, or pick another model." });
});
