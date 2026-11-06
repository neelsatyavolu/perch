import { afterAll, beforeAll, expect, test } from "bun:test";
import { newToolContext, runTool } from "../src/agent/tools";
import { looksBlocked, search, type Engine } from "../src/page/search";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const engine = (name: string, path: string): Engine => ({ name, url: (q) => env.site.url(`${path}?q=${encodeURIComponent(q)}`) });

test("results come back as title, real address and snippet", async () => {
  const tab = await env.browser.newTab();
  const text = await search(tab, "bird migration", { engines: [engine("Good", "/engine/results")], skips: new Map() });
  expect(text).toContain('Results for "bird migration" (Good):');
  expect(text).toContain("1. Result number 1 about bird migration\n   https://example.org/page-1\n   ");
  expect(text).toContain("Snippet 1: a short summary of page 1");
  expect(text).toContain("3. Result number 3");
  expect(text).not.toContain("Settings and privacy");
  await tab.close();
}, 30_000);

test("an engine with a bot check is skipped for the next one, and for later searches", async () => {
  const tab = await env.browser.newTab();
  const skips = new Map<string, number>();
  const engines = [engine("Walled", "/engine/blocked"), engine("Empty", "/engine/empty"), engine("Good", "/engine/results")];
  const first = await search(tab, "tides", { engines, skips });
  expect(first).toContain("Walled showed a bot check");
  expect(first).toContain("(Good):");
  expect(skips.has("Walled")).toBe(true);
  expect(skips.has("Empty")).toBe(false);
  const second = await search(tab, "moons", { engines, skips });
  expect(second).not.toContain("Walled");
  expect(second).toContain("(Good):");
  await tab.close();
}, 30_000);

test("when every engine is blocked or empty the agent is told why and what to try", async () => {
  const tab = await env.browser.newTab();
  const text = await search(tab, "x", { engines: [engine("Walled", "/engine/blocked"), engine("Empty", "/engine/empty")], skips: new Map() });
  expect(text).toStartWith('No results for "x" (Walled showed a bot check; Empty found nothing).');
  await tab.close();
}, 30_000);

test("an engine whose results share no word with the query counts as finding nothing", async () => {
  const tab = await env.browser.newTab();
  const text = await search(tab, "Flying Fortress bombers", { engines: [engine("Odd", "/engine/offtopic"), engine("Good", "/engine/results")], skips: new Map() });
  expect(text).toContain("(Good):");
  expect(text).not.toContain("letter B");
  await tab.close();
}, 30_000);

test("challenge pages are recognised by their words", () => {
  expect(looksBlocked("Just a moment...", "")).toBe(true);
  expect(looksBlocked("Search", "Please verify you are human")).toBe(true);
  expect(looksBlocked("Bird migration - Search", "Birds fly south in autumn")).toBe(false);
});

test("search is a tool the agent can call, and it reads without asking", async () => {
  const ctx = await newToolContext(env.browser);
  ctx.engines = [engine("Good", "/engine/results")];
  const result = await runTool(ctx, { id: "s", name: "search", args: { query: "ferns" } });
  expect(result.isError).toBeFalsy();
  expect(result.content).toContain("Result number 1 about ferns");
  const { classify } = await import("../src/agent/permissions");
  expect(classify({ id: "s", name: "search", args: { query: "ferns" } })).toBe("read");
  await ctx.close();
}, 30_000);
