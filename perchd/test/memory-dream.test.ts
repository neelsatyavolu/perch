import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dream } from "../src/memory/dream";
import { mockKeychain } from "../src/memory/keychain";
import { newPage } from "../src/memory/page";
import { MemoryStore } from "../src/memory/store";
import { fakeModel } from "../src/models/fake";
import type { TurnEvent } from "../src/models/types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
let clock = new Date("2026-11-05T03:00:00Z");
async function store() {
  const dir = mkdtempSync(join(tmpdir(), "perch-dream-"));
  dirs.push(dir);
  return MemoryStore.open({ dir, keys: mockKeychain(), profile: "default", now: () => clock });
}
const ops = (args: Record<string, unknown>): TurnEvent[] => [{ type: "tool_call", call: { id: "d", name: "consolidate", args } }, { type: "done" }];
const texts = (s: MemoryStore, path: string, section: "current" | "history" = "current") => s.get(path)![section].map((f) => f.text);

test("the rule pass merges duplicate facts and moves expired ones to History", async () => {
  const s = await store();
  const base = newPage("people/maya-chen.md", "Maya Chen", "2026-10-01T00:00:00.000Z");
  await s.replacePage(
    {
      ...base,
      current: [
        { text: "Designer", added: "2026-10-01T00:00:00.000Z", source: "chat" },
        { text: "designer.", added: "2026-10-02T00:00:00.000Z", source: "chat" },
        { text: "In Lisbon until Nov 1", added: "2026-10-01T00:00:00.000Z", source: "chat", expires: "2026-11-01" },
        { text: "Birthday is March 3", added: "2026-10-01T00:00:00.000Z", source: "chat" },
      ],
    },
    { action: "edit", detail: "test", source: "user" },
  );
  const report = await dream({ store: s, now: clock });
  expect(report).toMatchObject({ duplicates: 1, expired: 1, merged: 0, retired: 0 });
  expect(texts(s, "people/maya-chen.md")).toEqual(["Designer", "Birthday is March 3"]);
  expect(texts(s, "people/maya-chen.md", "history")).toEqual(["In Lisbon until Nov 1"]);
  const log = s.get("log/dreaming-2026-11-05.md")!;
  expect(log.current.map((f) => f.text)).toEqual(["people/maya-chen.md: removed 1 duplicate", "people/maya-chen.md: moved 1 expired fact to History"]);
  expect((await s.changes())[0]).toMatchObject({ action: "dream", source: "dreaming" });
});

test("episodic pages older than the retention setting are deleted", async () => {
  const s = await store();
  clock = new Date("2026-09-01T10:00:00Z");
  await s.addFacts([{ category: "episodic", title: "", text: "Old errand" }], "chat");
  clock = new Date("2026-11-05T03:00:00Z");
  await s.addFacts([{ category: "episodic", title: "", text: "Booked the dentist" }], "chat");
  expect((await dream({ store: s, now: clock })).episodicRemoved).toBe(0);
  await s.updateSettings({ episodicRetentionDays: 30 });
  expect((await dream({ store: s, now: clock })).episodicRemoved).toBe(1);
  expect(s.list().filter((p) => p.category === "episodic").map((p) => p.path)).toEqual(["episodic/2026-11-05.md"]);
});

test("the model pass merges and retires only facts that exist, and merges pages in one category", async () => {
  const s = await store();
  await s.addFacts(
    [
      { category: "user", title: "You", text: "Works at Acme" },
      { category: "user", title: "You", text: "Works at Globex since October" },
      { category: "user", title: "You", text: "Likes tea" },
      { category: "user", title: "You", text: "Enjoys green tea" },
      { category: "people", title: "Maya", text: "Sister" },
      { category: "people", title: "Maya Chen", text: "Lives in Lisbon" },
    ],
    "chat",
  );
  const model = fakeModel([
    ops({
      merge_facts: [
        { path: "USER.md", indexes: [2, 3], text: "Likes tea, especially green tea" },
        { path: "USER.md", indexes: [3, 9], text: "out of range" },
        { path: "USER.md", indexes: [0], text: "password: hunter22" },
      ],
      retire: [{ path: "USER.md", indexes: [0] }, { path: "nope.md", indexes: [0] }],
      merge_pages: [{ from: "people/maya.md", into: "people/maya-chen.md" }, { from: "USER.md", into: "people/maya-chen.md" }],
    }),
  ]);
  const report = await dream({ store: s, model, now: clock });
  expect(report).toMatchObject({ merged: 1, retired: 1, pagesMerged: 1, ignored: 4 });
  expect(model.requests[0]!.messages[0]!.role === "user" && model.requests[0]!.messages[0]!.text).toContain("USER.md (About you)\n  0. Works at Acme");
  expect(texts(s, "USER.md")).toEqual(["Works at Globex since October", "Likes tea, especially green tea"]);
  expect(texts(s, "USER.md", "history")).toEqual(["Works at Acme"]);
  expect(s.get("people/maya.md")).toBeNull();
  expect(texts(s, "people/maya-chen.md")).toEqual(["Lives in Lisbon", "Sister"]);
});

test("a failing model still leaves the rule pass done and says why", async () => {
  const s = await store();
  await s.addFacts([{ category: "user", title: "You", text: "Likes tea" }], "chat");
  const failing = { id: "x", async *turn(): AsyncIterable<TurnEvent> { throw new Error("offline"); } };
  const report = await dream({ store: s, model: failing, now: clock });
  expect(report.error).toBe("offline");
  expect(texts(s, "USER.md")).toEqual(["Likes tea"]);
});

test("pages merged into each other in a cycle are left alone", async () => {
  const s = await store();
  await s.addFacts([{ category: "people", title: "Maya", text: "Sister" }, { category: "people", title: "Maya Chen", text: "Lives in Lisbon" }], "chat");
  const model = fakeModel([ops({ merge_pages: [{ from: "people/maya.md", into: "people/maya-chen.md" }, { from: "people/maya-chen.md", into: "people/maya.md" }] })]);
  const report = await dream({ store: s, model, now: clock });
  expect(report).toMatchObject({ pagesMerged: 1, ignored: 1 });
  expect(texts(s, "people/maya-chen.md")).toEqual(["Lives in Lisbon", "Sister"]);
  expect(s.get("people/maya.md")).toBeNull();
});

test("a page changed while the model was thinking is not overwritten", async () => {
  const s = await store();
  await s.addFacts([{ category: "user", title: "You", text: "Likes tea" }, { category: "user", title: "You", text: "Enjoys tea" }], "chat");
  const slow = {
    id: "slow",
    async *turn(): AsyncIterable<TurnEvent> {
      clock = new Date("2026-11-05T03:05:00Z");
      await s.addFacts([{ category: "user", title: "You", text: "Moved to Berlin" }], "chat");
      yield* ops({ merge_facts: [{ path: "USER.md", indexes: [0, 1], text: "Likes tea" }] });
    },
  };
  const report = await dream({ store: s, model: slow, now: new Date("2026-11-05T03:00:00Z") });
  expect(texts(s, "USER.md")).toEqual(["Likes tea", "Enjoys tea", "Moved to Berlin"]);
  expect(report.skipped).toEqual(["USER.md"]);
  clock = new Date("2026-11-05T03:00:00Z");
});
