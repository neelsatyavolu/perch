import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatMemory } from "../src/memory/agent";
import { mockKeychain } from "../src/memory/keychain";
import { scoreFacts, sitePageFor } from "../src/memory/recall";
import { MemoryStore } from "../src/memory/store";
import { newPage } from "../src/memory/page";

const dirs: string[] = [];
const clock = new Date("2026-11-13T10:00:00.000Z");
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function open() {
  const dir = mkdtempSync(join(tmpdir(), "perch-recall-"));
  dirs.push(dir);
  return MemoryStore.open({ dir, keys: mockKeychain(), profile: "default", now: () => clock });
}

test("recall shows facts that match the message, and nothing for a passing word", async () => {
  const store = await open();
  await store.addFacts(
    [
      { category: "projects", title: "InFocus Portal", text: "Grades are entered on the Grade Editor page, one cycle at a time" },
      { category: "people", title: "Mr. Blackburn", text: "Teaches AP Macroeconomics at Paly" },
      { category: "concepts", title: "Cooking", text: "Prefers recipes without cilantro" },
    ],
    "chat",
  );
  const recalled = store.recallFor("Enter the cycle 3 grades in InFocus Portal").text;
  expect(recalled).toContain("Grade Editor page");
  expect(recalled).not.toContain("cilantro");
  expect(recalled).not.toContain("Macroeconomics");
  expect(store.recallFor("What should I make for dinner tonight, maybe something with rice and beans").text).toBe("");
});

test("newer records rank above older ones, and an older record says so", () => {
  const hit = (text: string, added: string, history = false) => ({ pageId: "p", path: "people/maya.md", title: "Maya", category: "people" as const, text, added, history, rank: -5 });
  const now = Date.parse("2026-11-13T00:00:00Z");
  const items = scoreFacts([hit("Maya lives in Porto", "2025-01-01T00:00:00Z", true), hit("Maya lives in Lisbon", "2026-11-01T00:00:00Z")], "where does Maya live", now);
  expect(items.map((i) => i.text)).toEqual(["Maya lives in Lisbon", "Maya lives in Porto"]);
  expect(items[1]!.history).toBe(true);
});

test("the site page for the tab comes in whole", async () => {
  const store = await open();
  await store.addFacts(
    [
      { category: "sites", title: "schoology.com", text: "Assignments are under Course, then Materials" },
      { category: "sites", title: "schoology.com", text: "Grades open in a new tab" },
      { category: "sites", title: "github.com", text: "Uses the dark theme" },
    ],
    "chat",
  );
  const recalled = store.recallFor("what's due tomorrow?", { url: "https://pausd.schoology.com/home" }).text;
  expect(recalled).toContain("What you know about pausd.schoology.com (schoology.com)");
  expect(recalled).toContain("Grades open in a new tab");
  expect(recalled).not.toContain("dark theme");
  expect(sitePageFor([newPage("sites/github-com.md", "GitHub", clock.toISOString())].map((p) => ({ ...p, category: "sites" as const })), "https://github.com/x")?.title).toBe("GitHub");
});

test("a fact recalled earlier in a chat is not shown again", async () => {
  const store = await open();
  await store.addFacts([{ category: "people", title: "Maya Chen", text: "Sister, birthday is 4 March" }], "chat");
  const memory = chatMemory(store)!;
  const first = await memory.context("task", { message: "Send Maya a birthday card", chatId: "c1" });
  expect(first).toContain("birthday is 4 March");
  expect(first).toContain("# Memory");
  const again = await memory.context("task", { message: "And a gift for Maya's birthday", chatId: "c1" });
  expect(again).not.toContain("birthday is 4 March");
  expect(await memory.context("task", { message: "Maya's birthday plans", chatId: "c2" })).toContain("birthday is 4 March");
});
