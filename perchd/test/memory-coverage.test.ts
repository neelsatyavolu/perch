import { expect, test } from "bun:test";
import { memoryGapsPrompt } from "../src/memory/build-chat";
import { memoryCoverage } from "../src/memory/coverage";
import type { Page } from "../src/memory/page";

let n = 0;
function page(category: Page["category"], texts: readonly string[]): Page {
  n++;
  const fact = (text: string) => ({ text, added: "2026-11-01", source: "import" as const });
  return { id: n.toString(16).padStart(32, "0"), path: `${category}/p${n}.md`, title: `P${n}`, category, current: texts.map(fact), history: [], created: "", updated: "" };
}
const filler = (k: number) => Array.from({ length: k }, (_, i) => `A fact number ${i}`);

test("empty memory is missing everything", () => {
  const c = memoryCoverage([]);
  expect(c.enough).toBe(false);
  expect(c.facts).toBe(0);
  expect(c.missing.length).toBe(5);
});

test("rich memory brought over from Aside is enough, so nothing is built", () => {
  const pages = [
    page("user", ["Email is a@example.com", "Phone is +1 555 0100", "Home address is 1 Main St", "Lives in Palo Alto", ...filler(40)]),
    page("people", ["Sam is a friend"]), page("people", ["Ana is a colleague"]), page("people", ["Mom"]),
    page("writing", ["Writes short lowercase emails"]),
    ...Array.from({ length: 5 }, () => page("sites", filler(12))),
  ];
  expect(memoryCoverage(pages)).toEqual({ enough: true, facts: 108, missing: [] });
});

test("memory that lacks some things names them, and the build chat fills only those", () => {
  const pages = [page("user", ["Email is a@example.com", "Phone is +1 555 0100", "Home address is 1 Main St", "Lives in Palo Alto", ...filler(120)])];
  const c = memoryCoverage(pages);
  expect(c.enough).toBe(false);
  expect(c.missing).toEqual([
    "the people you write to most, and how you know them",
    "how you write (tone, greetings, sign-offs, length) in email and chat",
    "the sites and services you use, your accounts, sizes and shopping preferences",
  ]);
  const prompt = memoryGapsPrompt(c.missing, c.facts);
  expect(prompt).toContain("already has 124 facts");
  expect(prompt).toContain("- how you write");
});

test("dated notes and logs don't count toward coverage", () => {
  expect(memoryCoverage([page("episodic", filler(500)), page("log", filler(500))]).facts).toBe(0);
});

test("other people's details, overflow pages and loose notes don't make a junk import count as enough", () => {
  const pages = [
    page("concepts", ["Bob's email is bob@example.com", "Bob lives in Paris", ...filler(300)]),
    page("sites", filler(200)),
    { ...page("sites", filler(200)), path: "sites/p999-2.md" },
    page("people", ["Sam is the owner"]),
  ];
  const c = memoryCoverage(pages);
  expect(c.enough).toBe(false);
  expect(c.missing[0]).toContain("contact details");
});
