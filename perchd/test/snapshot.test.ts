import { afterAll, beforeAll, expect, test } from "bun:test";
import { snapshot } from "../src/page/snapshot";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

test("mail page lists buttons, links and the search box with refs", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  const snap = await snapshot(tab);
  expect(snap.text).toMatch(/- heading "Mailroom" \[level=1\]/);
  expect(snap.text).toMatch(/- button "Compose" \[ref=e\d+\]/);
  expect(snap.text).toMatch(/- link "Maya Chen · Design review Thursday\?" \[ref=e\d+\]/);
  expect(snap.text).toMatch(/- searchbox "Search mail" \[ref=e\d+\]/);
  expect(snap.text).not.toContain('"Send"');
  await tab.close();
});

test("refs are stable across snapshots of the same page", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  const a = await snapshot(tab);
  const b = await snapshot(tab);
  expect(b.text).toBe(a.text);
  await tab.close();
});

test("secret fields never show their value", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  for (const id of ["password", "otp", "card", "email"]) {
    await tab.evaluate(`document.getElementById('${id}').focus()`);
    await tab.send("Input.insertText", { text: id === "email" ? "neel@example.com" : "hunter2-secret" });
  }
  const snap = await snapshot(tab);
  expect(snap.text).not.toContain("hunter2-secret");
  expect(snap.text).toMatch(/textbox "Password" \[ref=e\d+\] value="••••"/);
  expect(snap.text).toMatch(/textbox "Code" \[ref=e\d+\] value="••••"/);
  expect(snap.text).toMatch(/textbox "Card number" \[ref=e\d+\] value="••••"/);
  expect(snap.text).toContain('value="neel@example.com"');
  expect(snap.text).toMatch(/combobox "Country" \[ref=e\d+\] value="United States"/);
  expect(snap.text).toMatch(/checkbox "Remember me" \[ref=e\d+\] checked=false/);
  await tab.close();
});

test("a 10,000-row page stays within budget, says what it left out, and is fast", async () => {
  const tab = await env.browser.newTab(env.site.url("/long.html"));
  const started = performance.now();
  const snap = await snapshot(tab);
  const elapsed = performance.now() - started;
  expect(snap.text.length).toBeLessThanOrEqual(12_000);
  expect(snap.text).toMatch(/- … [\d,]+ more/);
  expect(snap.omitted).toBeGreaterThan(9000);
  expect(snap.text).toContain("View order 1");
  expect(elapsed).toBeLessThan(1500);
  await tab.close();
});

test("buttons inside an iframe and a shadow root get refs", async () => {
  const frame = await env.browser.newTab(env.site.url("/iframe.html"));
  await Bun.sleep(200);
  expect((await snapshot(frame)).text).toMatch(/- button "Inside frame" \[ref=e\d+\]/);
  await frame.close();
  const shadow = await env.browser.newTab(env.site.url("/shadow.html"));
  expect((await snapshot(shadow)).text).toMatch(/- button "Shadow button" \[ref=e\d+\]/);
  await shadow.close();
});

test("refs resolve to DOM nodes", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  const snap = await snapshot(tab);
  const ref = snap.text.match(/button "Compose" \[ref=(e\d+)\]/)![1]!;
  const target = snap.refs.resolve(ref);
  expect(target.backendNodeId).toBeGreaterThan(0);
  expect(() => snap.refs.resolve("e99999")).toThrow("ref e99999 is gone; take a new snapshot");
  await tab.close();
});

test("after scrolling, the snapshot follows the viewport and counts rows above", async () => {
  const tab = await env.browser.newTab(env.site.url("/long.html"));
  await tab.evaluate("scrollTo(0, 40000)");
  const snap = await snapshot(tab);
  expect(snap.text).toMatch(/- … [\d,]+ more above/);
  expect(snap.text).toMatch(/- … [\d,]+ more below/);
  expect(snap.text).not.toContain("View order 1\"");
  expect(snap.text).toMatch(/link "View order \d{4}" \[ref=e\d+\]/);
  await tab.close();
});

test("fixed banners inside containers placed far down the page are still listed", async () => {
  const tab = await env.browser.newTab(env.site.url("/banner.html"));
  const snap = await snapshot(tab);
  expect(snap.text).toMatch(/dialog "Privacy"/);
  expect(snap.text).toMatch(/button "Reject All" \[ref=e\d+\]/);
  await tab.close();
});
