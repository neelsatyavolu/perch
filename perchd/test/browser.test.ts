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

test("in the agent's tabs a passkey request is turned down at once, so no passkey window opens", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  const ask = `navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), timeout: 60000, userVerification: "preferred" } }).then(() => "got", (e) => e.name)`;
  const started = Date.now();
  expect(await tab.evaluate<string>(ask)).toBe("NotAllowedError");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await tab.evaluate<boolean>("PublicKeyCredential.isConditionalMediationAvailable()")).toBe(false);
  // Still so after the tab loads another page.
  await tab.navigate(env.site.url("/shop.html"));
  expect(await tab.evaluate<string>(ask)).toBe("NotAllowedError");
  await tab.close();
});

test("a browser page that opens with no opener during an action is found, a web page isn't", async () => {
  const since = Date.now();
  const { targetId: web } = await env.browser.conn.send<{ targetId: string }>("Target.createTarget", { url: env.site.url("/mail.html") });
  expect(await env.browser.internalOpenedSince(since)).toBeNull();
  const { targetId: internal } = await env.browser.conn.send<{ targetId: string }>("Target.createTarget", { url: "chrome://version/" });
  expect(await env.browser.internalOpenedSince(since)).toBe(internal);
  expect(await env.browser.internalOpenedSince(Date.now() + 1000)).toBeNull();
  for (const id of [web, internal]) await env.browser.conn.send("Target.closeTarget", { targetId: id });
});
