import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Tab } from "../src/browser/tab";
import { click } from "../src/page/actions";
import { snapshot, type Snapshot } from "../src/page/snapshot";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
let tab: Tab;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

function refOf(snap: Snapshot, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = snap.text.match(new RegExp(`${escaped} \\[ref=(e\\d+)\\]`));
  if (!match) throw new Error(`no ref for ${label} in:\n${snap.text}`);
  return match[1]!;
}

const out = () => tab.evaluate<string>("document.getElementById('out').textContent");

async function open(): Promise<Snapshot> {
  tab = await env.browser.newTab(env.site.url("/controls.html"));
  return snapshot(tab, { full: true });
}

test("a radio hidden behind its styled label is chosen through the label", async () => {
  const snap = await open();
  const result = await click(tab, snap.refs, refOf(snap, 'radio "10 miles"'));
  expect(result).toEqual({ ok: true, note: 'clicked radio "10 miles" (now checked)' });
  expect(await out()).toBe("Distance: 10");
  await tab.close();
});

test("a visually hidden checkbox inside its label is toggled", async () => {
  const snap = await open();
  expect(await click(tab, snap.refs, refOf(snap, 'checkbox "Private pool"'))).toMatchObject({ ok: true });
  expect(await out()).toBe("Pool: true");
  await tab.close();
});

test("clicks reach buttons in scroll boxes and far down a smooth-scrolling page", async () => {
  const snap = await open();
  expect(await click(tab, snap.refs, refOf(snap, 'button "Inside the box"'))).toMatchObject({ ok: true });
  expect(await out()).toBe("Clicked inner");
  expect(await click(tab, snap.refs, refOf(snap, 'button "Far below"'))).toMatchObject({ ok: true });
  expect(await out()).toBe("Clicked far");
  await tab.close();
});

test("buttons in closed shadow roots are clickable on a scrolled page", async () => {
  const snap = await open();
  await tab.evaluate("window.scrollTo({ top: 60, behavior: 'instant' })");
  expect(await click(tab, snap.refs, refOf(snap, 'button "Closed shadow button"'))).toMatchObject({ ok: true });
  expect(await out()).toBe("Clicked closed");
  await tab.close();
});

const COVER = "document.body.insertAdjacentHTML('beforeend', '<div style=\"position:fixed;inset:0;background:rgba(0,0,0,.3)\">Sign up for offers</div>')";

test("an overlay in the parent page covers buttons in same-site and cross-site iframes", async () => {
  tab = await env.browser.newTab(env.site.url("/iframe.html"));
  await Bun.sleep(200);
  let snap = await snapshot(tab);
  await tab.evaluate(COVER);
  const same = await click(tab, snap.refs, refOf(snap, 'button "Inside frame"'));
  expect(!same.ok && same.error).toMatch(/^covered by div "Sign up for offers"/);
  expect(await tab.evaluate<string>("document.getElementById('f').contentDocument.getElementById('out').textContent")).toBe("");
  await tab.close();
  tab = await env.browser.newTab(env.site.url("/xframe.html"));
  for (let i = 0; i < 40 && !(snap = await snapshot(tab)).text.includes("Book table"); i++) await Bun.sleep(100);
  await tab.evaluate(COVER);
  const cross = await click(tab, snap.refs, refOf(snap, 'button "Book table"'));
  expect(!cross.ok && cross.error).toMatch(/^covered by div "Sign up for offers"/);
  await tab.close();
});

test("a button under a fixed header is scrolled clear of it, then clicked", async () => {
  const snap = await open();
  await tab.evaluate("window.scrollTo({ top: document.getElementById('under').getBoundingClientRect().top + scrollY - 40, behavior: 'instant' })");
  expect(await click(tab, snap.refs, refOf(snap, 'button "Under the header"'))).toMatchObject({ ok: true });
  expect(await out()).toBe("Clicked under");
  await tab.close();
});
