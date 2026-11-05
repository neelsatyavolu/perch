import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { back, click, hover, press, scroll, select, type, upload, waitFor } from "../src/page/actions";
import { snapshot, type Snapshot } from "../src/page/snapshot";
import type { Tab } from "../src/browser/tab";
import { setup, tempProfile } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

function refOf(snap: Snapshot, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = snap.text.match(new RegExp(`${escaped} \\[ref=(e\\d+)\\]`));
  if (!match) throw new Error(`no ref for ${label} in:\n${snap.text}`);
  return match[1]!;
}

async function status(tab: Tab): Promise<string> {
  return tab.evaluate<string>("document.getElementById('status')?.textContent ?? document.getElementById('out')?.textContent ?? ''");
}

test("click opens the compose form, type fills it, and Send works", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  let snap = await snapshot(tab);
  expect(await click(tab, snap.refs, refOf(snap, 'button "Compose"'))).toMatchObject({ ok: true });
  snap = await snapshot(tab);
  expect(await type(tab, snap.refs, refOf(snap, 'textbox "To"'), "maya@chenstudio.co")).toMatchObject({ ok: true });
  expect(await type(tab, snap.refs, refOf(snap, 'textbox "Subject"'), "Thursday")).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('to').value")).toBe("maya@chenstudio.co");
  await click(tab, snap.refs, refOf(snap, 'button "Send"'));
  expect(await status(tab)).toBe("Message sent to maya@chenstudio.co");
  await tab.close();
});

test("type replaces what was in the field", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  const snap = await snapshot(tab);
  const ref = refOf(snap, 'textbox "Email"');
  await type(tab, snap.refs, ref, "old@example.com");
  await type(tab, snap.refs, ref, "new@example.com");
  expect(await tab.evaluate<string>("document.getElementById('email').value")).toBe("new@example.com");
  await tab.close();
});

test("select picks an option by label or value and fires change", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  const snap = await snapshot(tab);
  expect(await select(tab, snap.refs, refOf(snap, 'combobox "Country"'), "Canada")).toMatchObject({ ok: true });
  expect(await status(tab)).toBe("Country: ca");
  const missing = await select(tab, snap.refs, refOf(snap, 'combobox "Country"'), "Mars");
  expect(missing).toEqual({ ok: false, error: 'no option "Mars"; options are: United States, Canada, India' });
  await tab.close();
});

test("press Enter in the search box submits the form", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  const snap = await snapshot(tab);
  await type(tab, snap.refs, refOf(snap, 'searchbox "Search mail"'), "perch");
  expect(await press(tab, "Enter")).toMatchObject({ ok: true });
  expect(await status(tab)).toBe("Searched: perch");
  await tab.close();
});

test("upload finds the hidden file input behind a styled button", async () => {
  const profile = tempProfile();
  const file = join(profile.dir, "cv.pdf");
  writeFileSync(file, "%PDF");
  const tab = await env.browser.newTab(env.site.url("/hiddenfile.html"));
  const snap = await snapshot(tab);
  const buttons = [...snap.text.matchAll(/button "Upload file" \[ref=(e\d+)\]/g)].map((m) => m[1]!);
  expect(buttons.length).toBe(2);
  expect(await upload(tab, snap.refs, buttons[0]!, [file])).toMatchObject({ ok: true });
  expect(await upload(tab, snap.refs, buttons[1]!, [file])).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('resume').files[0]?.name")).toBe("cv.pdf");
  expect(await tab.evaluate<string>("document.getElementById('letter').files[0]?.name")).toBe("cv.pdf");
  expect(await upload(tab, snap.refs, refOf(snap, 'button "Not an upload"'), [file])).toMatchObject({ ok: false });
  await tab.close();
  profile.cleanup();
});

test("upload sets the file input", async () => {
  const profile = tempProfile();
  const file = join(profile.dir, "notes.txt");
  writeFileSync(file, "hello");
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  let snap = await snapshot(tab);
  await click(tab, snap.refs, refOf(snap, 'button "Compose"'));
  snap = await snapshot(tab);
  const attach = snap.text.match(/button "Attach[^"]*" \[ref=(e\d+)\]/)?.[1] ?? refOf(snap, 'button "Choose File"');
  expect(await upload(tab, snap.refs, attach, [file])).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('attach').files[0].name")).toBe("notes.txt");
  expect(await upload(tab, snap.refs, attach, [join(profile.dir, "missing.txt")])).toMatchObject({ ok: false });
  await tab.close();
  profile.cleanup();
});

test("a ref to an element the page removed fails without clicking anything else", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  let snap = await snapshot(tab);
  const maya = refOf(snap, 'link "Maya Chen · Design review Thursday?"');
  await click(tab, snap.refs, refOf(snap, 'button "Refresh"'));
  const result = await click(tab, snap.refs, maya);
  expect(result).toEqual({ ok: false, error: `ref ${maya} is gone; take a new snapshot` });
  await tab.close();
});

test("clicking a button hidden behind a dialog says what covers it", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  const snap = await snapshot(tab);
  await click(tab, snap.refs, refOf(snap, 'button "Show notice"'));
  const result = await click(tab, snap.refs, refOf(snap, 'button "Sign in"'));
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error).toMatch(/^covered by .*; close it first/);
  expect(await status(tab)).toBe("");
  await tab.close();
});

test("clicks reach buttons in iframes and shadow roots", async () => {
  const frame = await env.browser.newTab(env.site.url("/iframe.html"));
  await Bun.sleep(200);
  let snap = await snapshot(frame);
  expect(await click(frame, snap.refs, refOf(snap, 'button "Inside frame"'))).toMatchObject({ ok: true });
  expect(await frame.evaluate<string>("document.getElementById('f').contentDocument.getElementById('out').textContent")).toBe("Inner clicked");
  await frame.close();
  const shadow = await env.browser.newTab(env.site.url("/shadow.html"));
  snap = await snapshot(shadow);
  expect(await click(shadow, snap.refs, refOf(snap, 'button "Shadow button"'))).toMatchObject({ ok: true });
  expect(await status(shadow)).toBe("Shadow clicked");
  await shadow.close();
});

test("scroll, hover, waitFor and back", async () => {
  const tab = await env.browser.newTab(env.site.url("/long.html"));
  expect(await scroll(tab, { dy: 2000 })).toMatchObject({ ok: true });
  expect(await tab.evaluate<number>("scrollY")).toBeGreaterThan(1000);
  const snap = await snapshot(tab);
  const firstRef = snap.text.match(/\[ref=(e\d+)\]/)?.[1];
  if (!firstRef) throw new Error(`no refs after scrolling:\n${snap.text}`);
  expect(await hover(tab, snap.refs, firstRef)).toMatchObject({ ok: true });
  expect(await waitFor(tab, { text: "All orders", timeoutMs: 1000 })).toMatchObject({ ok: true });
  expect(await waitFor(tab, { text: "never appears", timeoutMs: 300 })).toEqual({ ok: false, error: 'waited 0.3s; "never appears" did not appear' });
  await tab.navigate(env.site.url("/shop.html"));
  expect(await back(tab)).toMatchObject({ ok: true });
  expect(await tab.title()).toBe("Orders");
  await tab.close();
});


test("action notes never include a secret field's value", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  const snap = await snapshot(tab);
  const ref = refOf(snap, 'textbox "Password"');
  await type(tab, snap.refs, ref, "hunter2-secret");
  const clicked = await click(tab, snap.refs, ref);
  const hovered = await hover(tab, snap.refs, ref);
  expect(JSON.stringify([clicked, hovered])).not.toContain("hunter2");
  await tab.close();
});
test("type sets date and time fields from ISO values and fires change", async () => {
  const tab = await env.browser.newTab(env.site.url("/dates.html"));
  const snap = await snapshot(tab);
  expect(snap.text).not.toContain("spinbutton");
  const dob = refOf(snap, 'date "Date of birth"');
  expect(await type(tab, snap.refs, dob, "1999-04-17")).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('dob').value")).toBe("1999-04-17");
  expect(await tab.evaluate<string>("document.getElementById('out').textContent")).toBe("dob 1999-04-17");
  const bad = await type(tab, snap.refs, dob, "April 17");
  expect(bad).toEqual({ ok: false, error: 'this is a date field; give the value as YYYY-MM-DD, for example 2026-11-05' });
  await tab.close();
});
