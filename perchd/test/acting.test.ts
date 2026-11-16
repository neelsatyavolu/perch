import { afterAll, beforeAll, expect, test } from "bun:test";
import { click, scroll, select, type, waitFor } from "../src/page/actions";
import { snapshot, type Snapshot } from "../src/page/snapshot";
import { rememberedSecrets, secretKey } from "../src/page/secrets";
import type { Tab } from "../src/browser/tab";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

function refOf(snap: Snapshot, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = snap.text.match(new RegExp(`${escaped} \\[ref=(e\\d+)\\]`));
  if (!match) throw new Error(`no ref for ${label} in:\n${snap.text}`);
  return match[1]!;
}

const value = (tab: Tab, id: string) => tab.evaluate<string>(`document.getElementById('${id}').value`);
const status = (tab: Tab) => tab.evaluate<string>("document.getElementById('status').textContent");

async function open(): Promise<{ tab: Tab; snap: Snapshot }> {
  const tab = await env.browser.newTab(env.site.url("/acting.html"));
  return { tab, snap: await snapshot(tab) };
}

test("clicking a native dropdown lists its options for select instead of opening a menu Perch can't see", async () => {
  const { tab, snap } = await open();
  const result = await click(tab, snap.refs, refOf(snap, 'combobox "Size"'));
  expect(result).toEqual({ ok: false, error: 'combobox "Size" is a dropdown; use select with one of its options: Small, Medium, Large (disabled)' });
  await tab.close();
});

test("select refuses a disabled option and names it", async () => {
  const { tab, snap } = await open();
  expect(await select(tab, snap.refs, refOf(snap, 'combobox "Size"'), "Large")).toEqual({ ok: false, error: 'option "Large" is disabled; choose another: Small, Medium' });
  expect(await value(tab, "size")).toBe("s");
  expect(await select(tab, snap.refs, refOf(snap, 'combobox "Size"'), "medium")).toEqual({ ok: true, note: 'selected "Medium"' });
  expect(await status(tab)).toBe("Size: m");
  await tab.close();
});

test("clicking a disabled button says so instead of clicking nothing", async () => {
  const { tab, snap } = await open();
  const result = await click(tab, snap.refs, refOf(snap, 'button "Save"'));
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error).toMatch(/^button "Save" is disabled; /);
  expect(await status(tab)).toBe("");
  expect(await click(tab, snap.refs, refOf(snap, 'button "Go"'))).toMatchObject({ ok: true });
  expect(await status(tab)).toBe("Went");
  await tab.close();
});

test("type explains a read-only field (a date picker) and a disabled one", async () => {
  const { tab, snap } = await open();
  const readOnly = await type(tab, snap.refs, refOf(snap, 'textbox "Departure"'), "2026-12-01");
  expect(readOnly).toEqual({ ok: false, error: 'textbox "Departure" is read-only; click it to open its picker, then choose from what appears' });
  const disabled = await type(tab, snap.refs, refOf(snap, 'textbox "Locked"'), "x");
  expect(disabled.ok).toBe(false);
  expect(!disabled.ok && disabled.error).toMatch(/^textbox "Locked" is disabled; /);
  await tab.close();
});

test("type into a combobox wrapper reaches the text field inside it", async () => {
  const { tab, snap } = await open();
  expect(await type(tab, snap.refs, refOf(snap, 'combobox "City"'), "Paris")).toMatchObject({ ok: true });
  expect(await value(tab, "city")).toBe("Paris");
  expect(await status(tab)).toBe("City: Paris");
  await tab.close();
});

test("type says what the field shows when the page reformats or cuts the text", async () => {
  const { tab, snap } = await open();
  const phone = await type(tab, snap.refs, refOf(snap, 'textbox "Phone"'), "5551234567");
  expect(phone).toEqual({ ok: true, note: 'typed 10 characters; the field now shows "(555) 123-4567"' });
  const zip = await type(tab, snap.refs, refOf(snap, 'textbox "Zip"'), "1234567");
  expect(zip).toEqual({ ok: true, note: 'typed 7 characters; the field now shows "12345"' });
  expect(await type(tab, snap.refs, refOf(snap, 'textbox "Note"'), "same")).toEqual({ ok: true, note: "typed 4 characters" });
  await tab.close();
});

test("type never reads back a field inside a wrapper that was once a secret", async () => {
  const { tab, snap } = await open();
  // The snapshot folds a combobox's own field into it, so the field is remembered as Perch would
  // remember any password field it has shown.
  const { result } = await tab.send<{ result: { objectId: string } }>("Runtime.evaluate", { expression: "document.getElementById('code')" });
  const { node } = await tab.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId: result.objectId });
  rememberedSecrets(tab).add(secretKey(node.backendNodeId));
  await tab.evaluate("document.getElementById('code').type = 'text'");
  expect(await type(tab, snap.refs, refOf(snap, 'combobox "Code"'), "123456")).toEqual({ ok: true, note: "typed 6 characters" });
  expect(await value(tab, "code")).toBe("1234");
  await tab.close();
});

test("wait_for can wait for text to go away, as a loading message does", async () => {
  const { tab } = await open();
  expect(await waitFor(tab, { text: "Loading results", gone: true, timeoutMs: 3000 })).toEqual({ ok: true, note: '"Loading results" is gone from the page' });
  expect(await waitFor(tab, { text: "Booking", gone: true, timeoutMs: 300 })).toEqual({ ok: false, error: 'waited 0.3s; "Booking" is still on the page' });
  await tab.close();
});

test("select on a type-to-search combobox types the choice and clicks the suggestion", async () => {
  const tab = await env.browser.newTab(env.site.url("/autocomplete.html"));
  const snap = await snapshot(tab);
  expect(await select(tab, snap.refs, refOf(snap, 'combobox "From"'), "San Diego")).toEqual({ ok: true, note: 'selected "SAN San Diego"' });
  expect(await tab.evaluate<string>("document.getElementById('out').textContent")).toBe("From: SAN San Diego");
  const missing = await select(tab, snap.refs, refOf(snap, 'combobox "From"'), "Oakland");
  expect(missing).toEqual({ ok: false, error: 'typed "Oakland" into combobox "From", but no option appeared; try a shorter or different spelling' });
  await tab.close();
});

test("a click that opens a file picker keeps it closed and points to upload", async () => {
  const tab = await env.browser.newTab(env.site.url("/hiddenfile.html"));
  const snap = await snapshot(tab);
  const ref = snap.text.match(/button "Upload file" \[ref=(e\d+)\]/)![1]!;
  expect(await click(tab, snap.refs, ref)).toEqual({ ok: true, note: `clicked button "Upload file"; it opened a file picker, which Perch kept closed: to attach files, use upload with ${ref}` });
  expect(await click(tab, snap.refs, refOf(snap, 'button "Not an upload"'))).toEqual({ ok: true, note: 'clicked button "Not an upload"' });
  await tab.close();
});

test("scroll with a ref and dy scrolls the panel the ref is in, not the page", async () => {
  const { tab, snap } = await open();
  const result = await scroll(tab, { refs: snap.refs, ref: refOf(snap, 'link "Folder 1"'), dy: 200 });
  expect(result.ok && result.note).toMatch(/^scrolled the scrollable panel to 200 of \d+ px/);
  expect(await tab.evaluate<number>("document.getElementById('panel').scrollTop")).toBe(200);
  expect(await tab.evaluate<number>("scrollY")).toBe(0);
  await tab.close();
});

test("type replaces a rich editor's text without a false note about what it shows", async () => {
  const { tab, snap } = await open();
  expect(await type(tab, snap.refs, refOf(snap, 'textbox "Message"'), "Hello there")).toEqual({ ok: true, note: "typed 11 characters" });
  expect(await tab.evaluate<string>("document.getElementById('message').innerText.trim()")).toBe("Hello there");
  await tab.close();
});
