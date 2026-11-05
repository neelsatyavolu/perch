import { afterAll, beforeAll, expect, test } from "bun:test";
import { click, type } from "../src/page/actions";
import { parseKey } from "../src/page/keys";
import { snapshot, type Snapshot } from "../src/page/snapshot";
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

test("type sends key events, so suggestion lists open, and says what was suggested", async () => {
  const tab = await env.browser.newTab(env.site.url("/autocomplete.html"));
  let snap = await snapshot(tab);
  const typed = await type(tab, snap.refs, refOf(snap, 'textbox "City or zip code"'), "Mia");
  expect(typed.ok && typed.note).toContain('3 suggestions appeared: "Miami, FL", "Miami Beach, FL", "Miami Gardens, FL"');
  snap = await snapshot(tab);
  expect(snap.text).toContain('link "job link"');
  expect(snap.text).not.toContain('clickable "Card');
  // A long clickable block keeps all of its text.
  expect(snap.text).toMatch(/- clickable \[ref=e\d+\]\n {2}- text "Senior HR partner, Miami\. .*whole region this year\."/);
  expect(await click(tab, snap.refs, refOf(snap, 'clickable "Miami, FL"'))).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('out').textContent")).toBe("Location: Miami, FL");
  const later = await type(tab, snap.refs, refOf(snap, 'combobox "From"'), "san");
  expect(later.ok && later.note).toContain("suggestions appeared");
  expect(later.ok && later.note).toContain('"SFO San Francisco"');
  await tab.close();
});

test("type into a plain field adds no suggestion note and keeps non-ASCII text", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  const snap = await snapshot(tab);
  const typed = await type(tab, snap.refs, refOf(snap, 'textbox "Email"'), "zoë+test@example.com");
  expect(typed).toEqual({ ok: true, note: "typed 20 characters" });
  expect(await tab.evaluate<string>("document.getElementById('email').value")).toBe("zoë+test@example.com");
  await tab.close();
});

test("press accepts a literal space and a plus sign", () => {
  expect(parseKey(" ")).toMatchObject({ def: { key: " ", code: "Space" }, modifiers: 0 });
  expect(parseKey("+")).toMatchObject({ def: { key: "+", code: "Equal" }, modifiers: 8 });
});

test("symbols are typed with their own key and Shift, never as arrow, Home or Page keys", async () => {
  const tab = await env.browser.newTab(env.site.url("/keys.html"));
  const snap = await snapshot(tab);
  const text = "$5 (a&b) 50% #1! \"Q\"";
  expect(await type(tab, snap.refs, refOf(snap, 'textbox "Note"'), text)).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('note').value")).toBe(text);
  expect(await tab.evaluate<string[]>("window.navKeys")).toEqual([]);
  expect(await tab.evaluate<string[]>("window.shifted")).toEqual(["$", "(", "&", ")", "%", "#", "!", "\"", "Q", "\""]);
  await tab.close();
});

test("press maps shifted symbols to their base key", () => {
  expect(parseKey("!")).toMatchObject({ def: { key: "!", code: "Digit1", keyCode: 49 }, modifiers: 8 });
  expect(parseKey("(")).toMatchObject({ def: { key: "(", code: "Digit9", keyCode: 57 }, modifiers: 8 });
  expect(parseKey("?")).toMatchObject({ def: { key: "?", code: "Slash", keyCode: 191 }, modifiers: 8 });
  // A letter named with Control stays Control+A: models write it in capitals.
  expect(parseKey("Control+A")).toMatchObject({ def: { code: "KeyA", keyCode: 65 }, modifiers: 2 });
});
