import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFromChat, renderTranscript } from "../src/memory/extract";
import { mockKeychain } from "../src/memory/keychain";
import { MemoryStore } from "../src/memory/store";
import { fakeModel } from "../src/models/fake";
import type { Message, TurnEvent } from "../src/models/types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function store() {
  const dir = mkdtempSync(join(tmpdir(), "perch-extract-"));
  dirs.push(dir);
  return MemoryStore.open({ dir, keys: mockKeychain(), profile: "default", now: () => new Date("2026-11-05T10:00:00Z") });
}

const chat: Message[] = [
  { role: "user", text: "Book a table for me and my sister Maya at a vegetarian place in Lisbon on Friday" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "navigate", args: { url: "https://www.thefork.pt" } }] },
  { role: "tool", callId: "c1", name: "navigate", content: `Page: TheFork (https://www.thefork.pt)\n${"- link \"x\"\n".repeat(400)}` },
  { role: "assistant", text: "", toolCalls: [{ id: "c2", name: "done", args: { answer: "Booked Ao 26 for Friday 8pm" } }] },
];

const file = (facts: unknown): TurnEvent[] => [{ type: "tool_call", call: { id: "x", name: "file_memories", args: { facts } } }, { type: "done" }];

test("the transcript keeps what the user said and the answer, and trims page dumps", () => {
  const text = renderTranscript(chat);
  expect(text).toContain("User: Book a table for me and my sister Maya");
  expect(text).toContain("Perch used navigate");
  expect(text).toContain("Perch finished: Booked Ao 26 for Friday 8pm");
  expect(text.length).toBeLessThan(2000);
});

test("extraction files the model's facts, tells it the existing pages, and refuses secrets", async () => {
  const s = await store();
  await s.addFacts([{ category: "people", title: "Maya Chen", text: "Sister" }], "setup");
  const model = fakeModel([
    file([
      { category: "people", title: "Maya Chen", text: "Vegetarian" },
      { category: "user", title: "You", text: "Visiting Lisbon in November", expires: "2026-12-01" },
      { category: "sites", title: "thefork.pt", text: "Account password is hunter22" },
    ]),
  ]);
  const result = await extractFromChat({ model, store: s, transcript: chat });
  expect(result).toMatchObject({ added: 2, duplicates: 0, rejected: [{ reason: "looks like a secret" }] });
  const req = model.requests[0]!;
  expect(req.tools.map((t) => t.name)).toEqual(["file_memories"]);
  expect(req.system).toContain("- people: one page per person");
  expect(req.messages[0]!.role === "user" && req.messages[0]!.text).toContain("people/maya-chen.md (Maya Chen)");
  expect(s.get("people/maya-chen.md")!.current.map((f) => f.text)).toEqual(["Sister", "Vegetarian"]);
  expect(s.get("USER.md")!.current[0]).toMatchObject({ text: "Visiting Lisbon in November", expires: "2026-12-01", source: "chat" });
});

test("nothing is extracted when memory is paused or off, in incognito, or from an empty chat", async () => {
  const s = await store();
  const model = fakeModel([]);
  expect(await extractFromChat({ model, store: s, transcript: chat, incognito: true })).toMatchObject({ skipped: "incognito" });
  expect(await extractFromChat({ model, store: s, transcript: [] })).toMatchObject({ skipped: "empty" });
  await s.updateSettings({ paused: true });
  expect(await extractFromChat({ model, store: s, transcript: chat })).toMatchObject({ skipped: "paused" });
  await s.updateSettings({ paused: false, extraction: false });
  expect(await extractFromChat({ model, store: s, transcript: chat })).toMatchObject({ skipped: "off" });
  expect(model.requests).toHaveLength(0);
});

test("bad model output saves nothing and says why", async () => {
  const s = await store();
  expect(await extractFromChat({ model: fakeModel([file("not a list")]), store: s, transcript: chat })).toMatchObject({ added: 0, error: "the model's answer was not a list of facts" });
  expect(await extractFromChat({ model: fakeModel([[{ type: "text", delta: "Nothing to save." }, { type: "done" }]]), store: s, transcript: chat })).toMatchObject({ added: 0 });
  expect(
    await extractFromChat({ model: fakeModel([file([{ category: 7, text: null }, "x", { category: "people", title: "A", text: "ok fact" }])]), store: s, transcript: chat }),
  ).toMatchObject({ added: 1, rejected: [{ reason: "unknown category" }, { reason: "unknown category" }] });
  const failing = { id: "boom", async *turn(): AsyncIterable<TurnEvent> { throw new Error("rate limited"); } };
  expect(await extractFromChat({ model: failing, store: s, transcript: chat })).toMatchObject({ added: 0, error: "rate limited" });
  expect(s.list().map((p) => p.path)).toEqual(["people/a.md"]);
});

test("at most 30 facts are taken from one chat", async () => {
  const s = await store();
  const many = Array.from({ length: 50 }, (_, i) => ({ category: "concepts", title: `Topic ${i}`, text: `Fact number ${i}` }));
  const result = await extractFromChat({ model: fakeModel([file(many)]), store: s, transcript: chat });
  expect(result.added).toBe(30);
});
