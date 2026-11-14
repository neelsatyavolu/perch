import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatMemory } from "../src/memory/agent";
import { mockKeychain } from "../src/memory/keychain";
import type { DraftHolder } from "../src/memory/setup";
import { MemoryStore } from "../src/memory/store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function open() {
  const dir = mkdtempSync(join(tmpdir(), "perch-research-"));
  dirs.push(dir);
  return MemoryStore.open({ dir, keys: mockKeychain(), profile: "default", now: () => new Date("2026-11-13T10:00:00Z") });
}

const call = (name: string, args: Record<string, unknown>) => ({ id: "c", name, args });

test("a chat saves findings itself; it isn't offered the review draft", async () => {
  const store = await open();
  const draft: DraftHolder = { current: null };
  const memory = chatMemory(store, { draft, history: async () => [] })!;
  expect(memory.specs.map((s) => s.name)).toEqual(["memory_search", "memory_save", "browsing_history"]);
  expect(memory.handles("memory_propose")).toBe(false);
});

test("browsing history is searchable by the agent, most visited first", async () => {
  const store = await open();
  const memory = chatMemory(store, {
    draft: { current: null },
    history: async () => [
      { url: "https://pausd.schoology.com/home", title: "Home | Schoology", visits: 40, lastVisit: "2026-11-12T00:00:00Z" },
      { url: "https://www.amazon.com/gp/your-account/order-history", title: "Your Orders", visits: 12, lastVisit: "2026-11-10T00:00:00Z" },
    ],
  })!;
  const all = await memory.run(call("browsing_history", {}));
  expect(all.content.split("\n")[0]).toContain("Home | Schoology");
  expect((await memory.run(call("browsing_history", { query: "orders" }))).content).toContain("amazon.com");
  expect((await memory.run(call("browsing_history", { query: "nothing like this" }))).content).toBe("Nothing in the browsing history matches.");
});

test("an unattended routine gets no research tools", async () => {
  const store = await open();
  expect(chatMemory(store, { draft: { current: null }, unattended: true })!.specs.map((s) => s.name)).toEqual(["memory_search", "memory_save"]);
});
