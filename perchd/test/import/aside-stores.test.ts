/**
 * Aside's memory, skills and chats landing in Perch's own stores through the `agent` writer:
 * real stores on temp folders, a generated Aside account, nothing from the real Mac.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ChatStore } from "../../src/app/chats";
import { memoryKeychain as appKeychain } from "../../src/app/keychain";
import type { PagesDeps } from "../../src/app/pages/deps";
import { agentWriter } from "../../src/app/pages/import-agent";
import { asideChatId } from "../../src/app/pages/import-chats";
import { pagePathFor, pagesFromAside } from "../../src/app/pages/import-memory";
import { Vault } from "../../src/app/vault";
import { BUNDLED_MESSAGE } from "../../src/import/apply";
import { openBundle, pendingBundles } from "../../src/import/bundle";
import { memoryKeychain } from "../../src/import/keychain";
import { importSource, type ImportInput } from "../../src/import/wizard";
import { mockKeychain } from "../../src/memory/keychain";
import { MemoryStore } from "../../src/memory/store";
import { MemoryKeychain } from "../../src/secure/keychain";
import { SkillStore } from "../../src/skills/store";
import { asideAgent, T0, tempHome, type AsideFixture } from "./fixtures";

const SOURCE = { browser: "aside-agent", profile: "0" };
const TYPES = ["memory", "skills", "chats"] as const;
const SKILL = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\nSteps.\n`;

const ACCOUNT: AsideFixture = {
  memory: {
    "USER.md": "# User\n\n## Current\n- Likes tea.\n- Lives in Lisbon.\n",
    "people/ada.md": "---\ntitle: Ada Lovelace\naliases: [Ada, Countess]\n---\n# Ada Lovelace\n\n## Current\n- Works on engines.\n\n## History\n- Met in 2025.\n",
    "episodic/2026-10-04.md": "# 2026-10-04\n\n## 20:53 PDT\nBooked a table for four.\n- Paid the deposit.\n",
    "users/sam.md": "- Sam is the owner.\n",
    "TAXONOMY.md": "# Filing rules\n- Aside's own rules.\n",
    "people/blank.md": "\n\n",
  },
  skills: { "mail/SKILL.md": SKILL("mail"), "mail/run.sh": "echo hi", "broken/notes.md": "no skill file here" },
  chats: [
    { id: "s1", title: "Flights", created: T0, turns: [["Find flights", "Found three."], ["Book the first", "Booked."]] },
    { id: "s2", title: "Unanswered", created: T0 + 5000, turns: [["Hello?", null]] },
  ],
};

let env: { home: string; cleanup: () => void };
let perch: string;
let memory: MemoryStore;
let skills: SkillStore;
let chats: ChatStore;
let vault: Vault;
const keychain = memoryKeychain();

async function openChats(): Promise<ChatStore> {
  return ChatStore.load(join(env.home, "chats"), vault);
}

beforeEach(async () => {
  env = tempHome();
  perch = join(env.home, "Library", "Application Support", "Perch");
  memory = await MemoryStore.open({ dir: join(env.home, "memory"), keys: mockKeychain(), profile: "default", now: () => new Date(T0) });
  skills = new SkillStore(join(env.home, "skills"), new MemoryKeychain());
  vault = await Vault.open(appKeychain(), "Default");
  chats = await openChats();
});
afterEach(() => {
  memory.close();
  env.cleanup();
});

const deps = (over: Partial<PagesDeps> = {}) => ({ chats, skills: { store: skills, home: env.home }, data: async () => ({ memory }), now: () => new Date(T0), ...over }) as unknown as PagesDeps;

function run(over: Partial<ImportInput> = {}) {
  return importSource({ home: env.home, source: SOURCE, types: TYPES, target: { userDataDir: perch }, keychain, agent: agentWriter(deps()), now: T0, ...over });
}

test("memory, skills and chats are written into Perch's stores and nothing is bundled", async () => {
  asideAgent(env.home, ACCOUNT);
  const report = await run();
  expect(report.results).toEqual([
    // TAXONOMY.md and the blank page have no place in Perch.
    { type: "memory", status: "written", count: 4, skipped: 2 },
    // The folder without a SKILL.md is left out.
    { type: "skills", status: "written", count: 1, skipped: 1 },
    { type: "chats", status: "written", count: 2 },
  ]);
  expect(report.bundle).toBeUndefined();
  expect(pendingBundles(perch)).toEqual([]);

  expect(memory.list().map((p) => p.path)).toEqual(["USER.md", "episodic/2026-10-04.md", "people/ada.md", "people/sam.md"]);
  const ada = memory.get("people/ada.md")!;
  expect(ada.title).toBe("Ada Lovelace");
  expect(ada.current).toEqual([
    { text: "Also known as: Ada, Countess", added: new Date(T0).toISOString(), source: "import" },
    { text: "Works on engines.", added: new Date(T0).toISOString(), source: "import" },
  ]);
  expect(ada.history.map((f) => f.text)).toEqual(["Met in 2025."]);
  expect(memory.get("episodic/2026-10-04.md")!.current.map((f) => f.text)).toEqual(["20:53 PDT: Booked a table for four.", "20:53 PDT: Paid the deposit."]);
  const changes = await memory.changes();
  expect(changes).toHaveLength(4);
  expect(changes.every((c) => c.action === "add" && c.source === "import" && c.detail === "Imported from Aside")).toBe(true);

  const mail = (await skills.list())[0]!;
  expect(mail).toMatchObject({ name: "mail", description: "Does mail.", source: "Aside" });
  expect(Object.keys(mail.files)).toEqual(["SKILL.md", "run.sh"]);

  const flights = chats.get(asideChatId("s1"))!;
  expect(flights).toMatchObject({ title: "Flights", createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0 + 2000).toISOString(), tab: null, draft: "" });
  expect(flights.messages.map((m) => [m.role, m.text, m.time])).toEqual([
    ["user", "Find flights", new Date(T0 + 1000).toISOString()],
    ["assistant", "Found three.", new Date(T0 + 1000).toISOString()],
    ["user", "Book the first", new Date(T0 + 2000).toISOString()],
    ["assistant", "Booked.", new Date(T0 + 2000).toISOString()],
  ]);
  expect(chats.get(asideChatId("s2"))!.messages.map((m) => m.role)).toEqual(["user"]);
  expect(chats.list().every((c) => c.tab === null)).toBe(true);
  // The chats are on disk, sealed, and open again.
  expect((await openChats()).get(asideChatId("s1"))!.messages).toHaveLength(4);
});

test("importing twice adds nothing twice, and Perch's own version of a page is kept", async () => {
  asideAgent(env.home, ACCOUNT);
  await run();
  const ada = memory.get("people/ada.md")!;
  await memory.replacePage({ ...ada, current: [{ text: "Edited in Perch.", added: ada.created, source: "user" }] }, { action: "edit", detail: "test", source: "user" });

  const again = await run();
  expect(again.results).toEqual([
    { type: "memory", status: "written", count: 0, skipped: 6 },
    { type: "skills", status: "written", count: 0, skipped: 2 },
    { type: "chats", status: "written", count: 0, skipped: 2 },
  ]);
  expect(memory.list()).toHaveLength(4);
  expect(memory.get("people/ada.md")!.current.map((f) => f.text)).toEqual(["Edited in Perch."]);
  expect(await skills.names()).toEqual(["mail"]);
  expect(chats.list()).toHaveLength(2);
  expect((await openChats()).list()).toHaveLength(2);
  expect(pendingBundles(perch)).toEqual([]);
});

test("without the writer the data is bundled as before; a later import with it empties that bundle", async () => {
  asideAgent(env.home, ACCOUNT);
  const bundled = await run({ agent: undefined });
  expect(bundled.results.map((r) => [r.type, r.status, r.message])).toEqual(TYPES.map((t) => [t, "bundled", BUNDLED_MESSAGE]));
  expect(Object.keys((await openBundle(perch, keychain, bundled.bundle!.id)).data).sort()).toEqual(["chats", "memory", "skills"]);
  expect(memory.list()).toEqual([]);

  // Only chats this time: they leave the bundle, memory and skills stay sealed in it.
  const partly = await run({ types: ["chats"] });
  expect(partly.results).toEqual([{ type: "chats", status: "written", count: 2 }]);
  const [left] = pendingBundles(perch);
  expect(Object.keys((await openBundle(perch, keychain, left!)).data).sort()).toEqual(["memory", "skills"]);

  const written = await run();
  expect(written.results.map((r) => r.status)).toEqual(["written", "written", "written"]);
  expect(pendingBundles(perch)).toEqual([]);
});

test("a type with no writer stays bundled while the others are written", async () => {
  asideAgent(env.home, ACCOUNT);
  const policy = { current: () => ({ MemoryEnabled: false }) } as unknown as PagesDeps["policy"];
  const report = await run({ agent: agentWriter(deps({ policy })) });
  expect(report.results.map((r) => [r.type, r.status])).toEqual([["memory", "bundled"], ["skills", "written"], ["chats", "written"]]);
  expect(Object.keys((await openBundle(perch, keychain, report.bundle!.id)).data)).toEqual(["memory"]);
  expect(memory.list()).toEqual([]);
});

test("a writer that fails reports the type as failed and leaves the rest alone", async () => {
  asideAgent(env.home, ACCOUNT);
  const report = await run({ agent: { ...agentWriter(deps()), chats: async () => Promise.reject(new Error("disk full")) } });
  expect(report.results.map((r) => [r.type, r.status])).toEqual([["memory", "written"], ["skills", "written"], ["chats", "failed"]]);
  expect(chats.list()).toEqual([]);
});

test("Aside's paths map onto Perch's folders", () => {
  expect(pagePathFor("USER.md")).toBe("USER.md");
  expect(pagePathFor("MEMORY.md")).toBe("MEMORY.md");
  expect(pagePathFor("TAXONOMY.md")).toBeNull();
  expect(pagePathFor("notes.txt")).toBeNull();
  expect(pagePathFor("people/Ada Lovelace.md")).toBe("people/ada-lovelace.md");
  expect(pagePathFor("users/sam.md")).toBe("people/sam.md");
  expect(pagePathFor("dreaming-history/2026-10-04.md")).toBe("log/2026-10-04.md");
  expect(pagePathFor("projects/perch/Release Plan.md")).toBe("projects/perch-release-plan.md");
  expect(pagePathFor("recipes/soup.md")).toBe("concepts/recipes-soup.md");
  expect(pagePathFor("loose.md")).toBe("concepts/loose.md");
});

test("long lines are split, secrets are left out, and a long file continues on more pages", async () => {
  const long = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
  const split = pagesFromAside({ path: "concepts/long.md", text: `## Notes\n${long}\n- password: hunter2-fake\n- Fine line.\n- Fine line.\n` })!;
  expect(split.secrets).toBe(1);
  const facts = split.pages[0]!.current;
  expect(facts.every((f) => f.length <= 500 && f.startsWith("Notes: "))).toBe(true);
  expect(facts.map((f) => f.slice("Notes: ".length)).slice(0, -1).join(" ")).toBe(long);
  expect(facts.at(-1)).toBe("Notes: Fine line.");

  const many = Array.from({ length: 450 }, (_, i) => `- Fact number ${i}.`).join("\n");
  const big = pagesFromAside({ path: "projects/big.md", text: `# Big\n${many}\n` })!;
  expect(big.pages.map((p) => [p.path, p.title, p.current.length])).toEqual([["projects/big.md", "Big", 200], ["projects/big-2.md", "Big (2)", 200], ["projects/big-3.md", "Big (3)", 50]]);

  asideAgent(env.home, { memory: { "projects/big.md": `# Big\n${many}\n` } });
  const report = await run({ types: ["memory"] });
  expect(report.results).toEqual([{ type: "memory", status: "written", count: 1 }]);
  expect(memory.list().map((p) => [p.path, p.facts])).toEqual([["projects/big-2.md", 200], ["projects/big-3.md", 50], ["projects/big.md", 200]]);
});

test("the store refuses pages it would not hold, whatever the caller sends", async () => {
  const result = await memory.addPages(
    [
      { path: "people/ok.md", title: "Ok", current: ["Fine."] },
      { path: "people/ok.md", title: "Twice", current: ["Second."] },
      { path: "aside/nope.md", title: "Bad folder", current: ["x"] },
      { path: "people/secret.md", title: "Secret", current: ["password: hunter2-fake"] },
      { path: "people/empty.md", title: "Empty", current: ["  "] },
      { path: "people/huge.md", title: "Huge", current: Array.from({ length: 201 }, (_, i) => `Fact ${i}`) },
    ],
    "import",
    "Imported from Aside",
  );
  expect(result.added).toEqual(["people/ok.md"]);
  expect(result.skipped.map((s) => s.reason)).toEqual(["a page is already there", "not a memory page path", "looks like a secret", "empty", "too many facts"]);
  expect(memory.get("people/ok.md")!.title).toBe("Ok");
});

test("about 200 pages and 600 chats import in a few seconds", async () => {
  const memoryFiles = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`${["people", "projects", "sites", "episodic"][i % 4]}/page-${i}.md`, `# Page ${i}\n\n## Current\n${Array.from({ length: 40 }, (_, j) => `- Fact ${j} of page ${i} with a little more text to make the line a realistic length.`).join("\n")}\n`]),
  );
  const manyChats = Array.from({ length: 600 }, (_, i) => ({
    id: `chat-${i}`,
    title: `Chat ${i}`,
    created: T0 + i * 60_000,
    turns: Array.from({ length: 6 }, (_, j): [string, string] => [`Question ${j} in chat ${i}?`, `Answer ${j}. `.repeat(60)]),
  }));
  asideAgent(env.home, { memory: memoryFiles, skills: { "mail/SKILL.md": SKILL("mail") }, chats: manyChats });

  const started = performance.now();
  const first = await run();
  const firstMs = performance.now() - started;
  const second = await run();
  const secondMs = performance.now() - started - firstMs;
  console.info(`aside import: 200 pages + 600 chats in ${firstMs.toFixed(0)} ms; again (all skipped) in ${secondMs.toFixed(0)} ms`);

  expect(first.results.map((r) => [r.type, r.count])).toEqual([["memory", 200], ["skills", 1], ["chats", 600]]);
  expect(second.results.map((r) => [r.count, r.skipped])).toEqual([[0, 200], [0, 1], [0, 600]]);
  expect(memory.list()).toHaveLength(200);
  expect(chats.list()).toHaveLength(600);
  expect(firstMs).toBeLessThan(5000);
  expect(secondMs).toBeLessThan(5000);
});
