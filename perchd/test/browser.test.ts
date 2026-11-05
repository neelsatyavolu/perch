import { afterAll, beforeAll, expect, test } from "bun:test";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

test("a new tab navigates and reports its title and URL", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  expect(await tab.title()).toBe("Mailroom");
  expect(await tab.url()).toBe(env.site.url("/mail.html"));
  await tab.close();
});

test("tabs() lists every open page", async () => {
  const a = await env.browser.newTab(env.site.url("/mail.html"));
  const b = await env.browser.newTab(env.site.url("/shop.html"));
  const titles = (await env.browser.tabs()).map((t) => t.title);
  expect(titles).toContain("Mailroom");
  expect(titles).toContain("Northwind Shop");
  await a.close();
  await b.close();
});

test("a redirect ends on the final URL", async () => {
  const tab = await env.browser.newTab();
  await tab.navigate(env.site.url("/redirect"));
  expect(await tab.url()).toBe(env.site.url("/mail.html"));
  await tab.close();
});

test("evaluate returns values and surfaces page errors", async () => {
  const tab = await env.browser.newTab(env.site.url("/shop.html"));
  expect(await tab.evaluate<number>("1 + 2")).toBe(3);
  await expect(tab.evaluate("missingThing.x")).rejects.toThrow(/missingThing/);
  await tab.close();
});

test("closing a tab mid-navigation fails that call and the browser keeps working", async () => {
  const tab = await env.browser.newTab();
  const nav = tab.navigate(env.site.url("/slow"));
  await Bun.sleep(100);
  await env.browser.conn.send("Target.closeTarget", { targetId: tab.id });
  await expect(nav).rejects.toThrow("tab closed");
  const next = await env.browser.newTab(env.site.url("/shop.html"));
  expect(await next.title()).toBe("Northwind Shop");
  await next.close();
});
