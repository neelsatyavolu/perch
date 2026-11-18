import { afterAll, beforeAll, expect, test } from "bun:test";
import { click, type } from "../src/page/actions";
import { screenshot } from "../src/page/screenshot";
import { snapshot } from "../src/page/snapshot";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const refOf = (text: string, label: string) => {
  const m = text.match(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[ref=(e\\d+)\\]`));
  if (!m) throw new Error(`no ${label} in\n${text}`);
  return m[1]!;
};

async function frameReady(tab: Awaited<ReturnType<typeof env.browser.newTab>>) {
  for (let i = 0; i < 40; i++) {
    const s = await snapshot(tab);
    if (s.text.includes("Book table")) return s;
    await Bun.sleep(100);
  }
  return snapshot(tab);
}

test("a cross-site iframe's controls are listed, clickable and typeable", async () => {
  const tab = await env.browser.newTab(env.site.url("/xframe.html"));
  let snap = await frameReady(tab);
  expect(snap.text).toMatch(/- iframe/);
  expect(await type(tab, snap.refs, refOf(snap.text, 'textbox "Guest name"'), "Maya Chen")).toMatchObject({ ok: true });
  expect(await click(tab, snap.refs, refOf(snap.text, 'button "Book table"'))).toMatchObject({ ok: true });
  await Bun.sleep(200);
  snap = await snapshot(tab);
  expect(snap.text).toContain("Booked for Maya Chen");
  await tab.close();
}, 20_000);

test("secrets inside a cross-site iframe stay masked in snapshots and screenshots", async () => {
  const tab = await env.browser.newTab(env.site.url("/xframe.html"));
  let snap = await frameReady(tab);
  await type(tab, snap.refs, refOf(snap.text, 'textbox "Account password"'), "hunter2-secret");
  snap = await snapshot(tab);
  expect(snap.text).not.toContain("hunter2");
  expect(snap.text).toMatch(/textbox "Account password" \[ref=e\d+\] value="••••"/);
  const shot = await screenshot(tab);
  const check = await env.browser.newTab();
  const box = { x: 20 + 0, y: 0 };
  void box;
  const dark = await check.evaluate<number>(`new Promise((resolve) => { const img = new Image(); img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 30) n++; resolve(n); };
    img.src = 'data:image/jpeg;base64,${shot.jpegBase64}'; })`);
  expect(dark).toBeGreaterThan(200 * 20);
  await check.close();
  await tab.close();
}, 20_000);

test("a click at a point inside a cross-site iframe is judged by what is there", async () => {
  const { newToolContext, runTool, liveTarget } = await import("../src/agent/tools");
  const { classify } = await import("../src/agent/permissions");
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, { id: "n", name: "navigate", args: { url: env.site.url("/xframe.html") } });
  await frameReady(ctx.tab!);
  const frame = await ctx.tab!.evaluate<{ x: number; y: number }>("(() => { const r = document.getElementById('x').getBoundingClientRect(); return { x: r.left, y: r.top }; })()");
  const [session] = [...ctx.tab!.frameSessions.values()];
  const { result } = await ctx.tab!.sendIn<{ result: { value: { name: number[]; go: number[] } } }>(session, "Runtime.evaluate", {
    expression: "(() => { const c = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }; return { name: c('name'), go: c('go') }; })()",
    returnByValue: true,
  });
  const at = ([x, y]: number[]) => ({ id: "c", name: "click_at", args: { x: frame.x + x!, y: frame.y + y! } });
  const field = await liveTarget(ctx, at(result.value.name));
  expect(field).toEqual({ role: "textbox", name: "Guest name" });
  expect(classify(at(result.value.name), field)).toBe("change");
  expect(await liveTarget(ctx, at(result.value.go))).toEqual({ role: "button", name: "Book table" });
  await ctx.close();
}, 20_000);
