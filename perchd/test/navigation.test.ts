import { afterAll, beforeAll, expect, test } from "bun:test";
import { openPage, STILL_LOADING } from "../src/page/navigation";
import { snapshot } from "../src/page/snapshot";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

test("a page whose load event never fires is returned once parsed, with a note", async () => {
  const tab = await env.browser.newTab();
  const started = Date.now();
  expect(await openPage(tab, env.site.url("/never-loads"), { loadMs: 800 })).toBe(STILL_LOADING);
  expect(Date.now() - started).toBeLessThan(3000);
  expect((await snapshot(tab)).text).toContain("Apartment on Elm Street");
  await tab.close();
});

test("a normal page opens with no note, and a dead address still fails", async () => {
  const tab = await env.browser.newTab();
  expect(await openPage(tab, env.site.url("/shop.html"))).toBe("");
  await expect(openPage(tab, "http://127.0.0.1:1/")).rejects.toThrow(/failed/);
  await tab.close();
});
