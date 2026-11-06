import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { newToolContext, runTool } from "../src/agent/tools";
import { anthropicModel } from "../src/models/anthropic";
import { IDLE_MS } from "../src/models/http";
import { responsesModel } from "../src/models/responses";
import { click, press, type } from "../src/page/actions";
import { repl } from "../src/page/repl";
import { screenshot } from "../src/page/screenshot";
import { snapshot, type Snapshot } from "../src/page/snapshot";
import type { Tab } from "../src/browser/tab";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });
function refOf(snap: Snapshot, label: string): string {
  const m = snap.text.match(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[ref=(e\\d+)\\]`));
  if (!m) throw new Error(`no ${label} in\n${snap.text}`);
  return m[1]!;
}
async function pixel(jpeg: string, x: number, y: number): Promise<[number, number, number]> {
  const tab = await env.browser.newTab();
  const rgb = await tab.evaluate<[number, number, number]>(`new Promise((resolve) => { const img = new Image(); img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(${Math.round(x)}, ${Math.round(y)}, 1, 1).data; resolve([d[0], d[1], d[2]]); }; img.src = 'data:image/jpeg;base64,${jpeg}'; })`);
  await tab.close();
  return rgb;
}

test("a confirm dialog is dismissed and reported, not left hanging", async () => {
  const ctx = await newToolContext(env.browser);
  const opened = await runTool(ctx, call("navigate", { url: env.site.url("/dialog.html") }));
  const ref = opened.content.match(/button "Delete" \[ref=(e\d+)\]/)![1]!;
  const clicked = await runTool(ctx, call("click", { ref }));
  expect(clicked.content).toContain('The page showed a confirm dialog: "Delete everything?". Perch dismissed it.');
  expect(await ctx.tab!.evaluate<string>("document.getElementById('out').textContent")).toBe("kept");
  await ctx.close();
}, 15_000);

test("a frozen page fails the call instead of hanging", async () => {
  const tab = await env.browser.newTab(env.site.url("/dialog.html"));
  tab.timeoutMs = 1500;
  const snap = await snapshot(tab);
  const started = Date.now();
  const result = await click(tab, snap.refs, refOf(snap, 'button "Freeze"'));
  expect(Date.now() - started).toBeLessThan(6000);
  expect(result).toEqual({ ok: false, error: "the page stopped responding" });
  await env.browser.conn.send("Target.closeTarget", { targetId: tab.id });
}, 15_000);

test("after a click that navigates, the result shows the new page", async () => {
  const ctx = await newToolContext(env.browser);
  const opened = await runTool(ctx, call("navigate", { url: env.site.url("/dialog.html") }));
  const ref = opened.content.match(/link "Slow shop" \[ref=(e\d+)\]/)![1]!;
  const clicked = await runTool(ctx, call("click", { ref }));
  expect(clicked.content).toContain("Page: Northwind Shop");
  await ctx.close();
}, 15_000);

test("a field that was a password stays masked after Show password", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  let snap = await snapshot(tab);
  await type(tab, snap.refs, refOf(snap, 'textbox "Password"'), "hunter2-secret");
  await click(tab, snap.refs, refOf(snap, 'button "Show password"'));
  snap = await snapshot(tab);
  expect(snap.text).not.toContain("hunter2");
  expect(snap.text).toMatch(/textbox "Password" \[ref=e\d+\] value="••••"/);
  await tab.close();
});

test("links inside headings and options inside listboxes get refs; a label-covered checkbox clicks", async () => {
  const tab = await env.browser.newTab(env.site.url("/news.html"));
  const snap = await snapshot(tab);
  expect(snap.text).toMatch(/link "Headline one" \[ref=e\d+\]/);
  expect(snap.text).toMatch(/option "Oldest" \[ref=e\d+\]/);
  expect(await click(tab, snap.refs, refOf(snap, 'checkbox "Notifications"'))).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('out').textContent")).toBe("notify true");
  await tab.close();
});

test("a screenshot after scrolling shows what is on screen", async () => {
  const tab = await env.browser.newTab(env.site.url("/color.html"));
  await tab.evaluate("scrollTo(0, 3200)");
  const shot = await screenshot(tab);
  const [r, g, b] = await pixel(shot.jpegBase64, shot.width / 2, shot.height / 2);
  expect(r).toBeGreaterThan(200);
  expect(g + b).toBeLessThan(80);
  await tab.close();
});

test("screenshots cover secret fields inside iframes and shadow roots", async () => {
  const tab = await env.browser.newTab(env.site.url("/payframe.html"));
  await Bun.sleep(300);
  await tab.evaluate("document.getElementById('f').contentDocument.getElementById('p').value = 'secret-in-frame'");
  await tab.evaluate("document.querySelector('secret-box').shadowRoot.getElementById('s').value = 'secret-in-shadow'");
  const boxes = await tab.evaluate<{ x: number; y: number }[]>(`(() => {
    const f = document.getElementById('f'); const fr = f.getBoundingClientRect(); const p = f.contentDocument.getElementById('p').getBoundingClientRect();
    const s = document.querySelector('secret-box').shadowRoot.getElementById('s').getBoundingClientRect();
    return [{ x: fr.x + p.x + p.width / 2, y: fr.y + p.y + p.height / 2 }, { x: s.x + s.width / 2, y: s.y + s.height / 2 }];
  })()`);
  const shot = await screenshot(tab);
  for (const box of boxes) {
    const [r, g, b] = await pixel(shot.jpegBase64, box.x, box.y);
    expect(r + g + b).toBeLessThan(60);
  }
  await tab.close();
});

test("the REPL is read-only and cannot reach secrets through frames or attribute changes", async () => {
  const tab = await env.browser.newTab(env.site.url("/payframe.html"));
  await Bun.sleep(300);
  await tab.evaluate("document.getElementById('f').contentDocument.getElementById('p').value = 'secret-in-frame'");
  const viaFrame = await repl(tab, "return document.getElementById('f').contentDocument.getElementById('p').value");
  expect(JSON.stringify(viaFrame)).not.toContain("secret-in-frame");
  const form = await env.browser.newTab(env.site.url("/form.html"));
  await form.evaluate("document.getElementById('password').value = 'hunter2-secret'");
  const viaType = await repl(form, "const el = document.getElementById('password'); el.type = 'text'; return el.value");
  expect(JSON.stringify(viaType)).not.toContain("hunter2");
  expect(await repl(form, "document.getElementById('signin').click()")).toMatchObject({ error: "the REPL is read-only; use click, type and select to change the page" });
  expect(await repl(form, "document.body.insertAdjacentHTML('beforeend', '<img src=x onerror=alert(1)>')")).toMatchObject({ error: "the REPL is read-only; use click, type and select to change the page" });
  expect(await form.evaluate<string>("document.getElementById('status').textContent")).toBe("");
  expect(await repl(form, "return [...document.querySelectorAll('label')].length")).toEqual({ result: 6 });
  await tab.close();
  await form.close();
});

test("the REPL sees what was typed, chosen and ticked, except secrets", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  let snap = await snapshot(tab);
  await type(tab, snap.refs, refOf(snap, 'textbox "Email"'), "ada@example.com");
  await type(tab, snap.refs, refOf(snap, 'textbox "Password"'), "hunter2-secret");
  await type(tab, snap.refs, refOf(snap, 'textbox "Code"'), "123456");
  await type(tab, snap.refs, refOf(snap, 'textbox "Card number"'), "4111111111111111");
  await click(tab, snap.refs, refOf(snap, 'checkbox "Remember me"'));
  await tab.evaluate("document.getElementById('country').value = 'ca'");
  // A field that was shown as a password stays secret after Show password turns it into text.
  await click(tab, snap.refs, refOf(snap, 'button "Show password"'));
  // Its name no longer says "password" either: only having been one keeps it secret.
  await tab.evaluate("const p = document.getElementById('password'); p.id = 'field7'; p.removeAttribute('autocomplete')");
  snap = await snapshot(tab);
  const seen = await repl(tab, "return [...document.querySelectorAll('input, select')].map((el) => el.id + '=' + (el.type === 'checkbox' ? el.checked : el.value)).join(' ')");
  expect(seen.result).toBe("email=ada@example.com field7= otp= card= country=ca remember=true");
  const upload = await env.browser.newTab(env.site.url("/hiddenfile.html"));
  const file = join(mkdtempSync(join(tmpdir(), "up-")), "notes.txt");
  writeFileSync(file, "hello");
  const input = await upload.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1 });
  const { nodeId } = await upload.send<{ nodeId: number }>("DOM.querySelector", { nodeId: input.root.nodeId, selector: "input[type=file]" });
  await upload.send("DOM.setFileInputFiles", { nodeId, files: [file] });
  expect(await repl(upload, "return [...document.querySelector('input[type=file]').files].map((f) => f.name)")).toEqual({ result: ["notes.txt"] });
  await upload.close();
  await tab.close();
});

test("a secret the REPL finds first stays hidden after it is shown as text", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  // No snapshot before the REPL: the REPL must remember the password field itself.
  await tab.evaluate("document.getElementById('password').value = 'hunter2-secret'");
  expect(JSON.stringify(await repl(tab, "return document.getElementById('password').value"))).not.toContain("hunter2");
  await tab.evaluate("const p = document.getElementById('password'); p.type = 'text'; p.id = 'plain'; p.removeAttribute('autocomplete'); p.setAttribute('value', p.value)");
  const seen = await repl(tab, "const el = document.getElementById('plain'); return [el.value, el.defaultValue, el.outerHTML].join(' ')");
  expect(JSON.stringify(seen)).not.toContain("hunter2");
  await tab.close();
});

test("secret text areas and selects are hidden, and reading fields runs none of the page's code", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  await tab.evaluate(`document.body.insertAdjacentHTML('beforeend', '<textarea id="verify" autocomplete="one-time-code"></textarea><select id="expiry" autocomplete="cc-exp-month"><option>01</option><option>07</option></select><input id="note"><input id="code2" autocomplete="section-login one-time-code"><input id="login2" autocomplete="current-password"><select id="saved" autocomplete="cc-number"><option>4111 1111 1111 1111</option></select>');
    document.getElementById('verify').value = '845201';
    document.getElementById('expiry').selectedIndex = 1;
    document.getElementById('note').value = 'plain words';
    document.getElementById('code2').value = '990011';
    document.getElementById('login2').value = 'hunter3';
    Object.defineProperty(HTMLInputElement.prototype, 'value', { get() { window.__ran = true; return 'from the page'; }, configurable: true });
    true`);
  const seen = await repl(tab, "return [document.getElementById('verify').value, document.getElementById('expiry').value, document.getElementById('note').value].join('|')");
  expect(seen.result).toBe("||plain words");
  const others = await repl(tab, "const s = document.getElementById('saved'); return [document.getElementById('code2').value, document.getElementById('login2').value, s.outerHTML, s.textContent].join('|')");
  expect(JSON.stringify(others)).not.toMatch(/990011|hunter3|4111/);
  expect(await tab.evaluate<boolean>("window.__ran === true")).toBe(false);
  await tab.close();
});

test("REPL code cannot change how the next REPL call is cleaned", async () => {
  const tab = await env.browser.newTab(env.site.url("/form.html"));
  await tab.evaluate("document.body.insertAdjacentHTML('beforeend', '<select id=\"saved\" autocomplete=\"cc-number\"><option>4111 1111 1111 1111</option></select>'); document.getElementById('password').setAttribute('value', 'hunter2-secret'); true");
  await repl(tab, "window.__perchClear = () => {}; window.__perchStrip = () => {}; Element.prototype.querySelectorAll = () => []; Document.prototype.querySelectorAll = () => []; return null");
  const seen = await repl(tab, "return document.getElementById('saved').textContent + '|' + document.getElementById('password').outerHTML");
  expect(JSON.stringify(seen)).not.toMatch(/4111|hunter2/);
  await tab.close();
});

test("Meta+A selects all and punctuation types the right character", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  let snap = await snapshot(tab);
  await click(tab, snap.refs, refOf(snap, 'button "Compose"'));
  snap = await snapshot(tab);
  await type(tab, snap.refs, refOf(snap, 'textbox "Subject"'), "Thursday");
  await press(tab, "Meta+a");
  await press(tab, "Delete");
  await press(tab, ",");
  expect(await tab.evaluate<string>("document.getElementById('subject').value")).toBe(",");
  await tab.close();
});

test("a browser killed mid-session fails calls without crashing perchd", async () => {
  const { Browser } = await import("../src/browser/browser");
  const { tempProfile } = await import("./helpers");
  const profile = tempProfile();
  const browser = await Browser.launch({ userDataDir: profile.dir });
  const { processInfo } = await browser.conn.send<{ processInfo: unknown }>("SystemInfo.getProcessInfo").catch(() => ({ processInfo: null }));
  void processInfo;
  const pid = (browser.conn as unknown as { pid?: number }).pid;
  expect(pid).toBeGreaterThan(0);
  process.kill(pid!, "SIGKILL");
  for (let i = 0; i < 5; i++) await expect(browser.conn.send("Browser.getVersion")).rejects.toThrow(/browser closed/);
  profile.cleanup();
});

const OK_STREAM = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
test("a rejected effort is remembered, so later turns do not fail first", async () => {
  const bodies: string[] = [];
  let first = true;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    if (first) { first = false; return new Response('{"error":{"message":"reasoning.effort is not supported"}}', { status: 400 }); }
    return new Response(OK_STREAM, { status: 200 });
  }) as unknown as typeof fetch;
  const model = responsesModel({ provider: "codex", model: "m", getToken: async () => ({ accessToken: "t" }) }, fetchImpl);
  const req = { system: "s", messages: [{ role: "user" as const, text: "hi" }], tools: [], effort: "high" as const };
  for await (const _ of model.turn(req, new AbortController().signal)) void _;
  for await (const _ of model.turn(req, new AbortController().signal)) void _;
  expect(bodies).toHaveLength(3);
  expect(JSON.parse(bodies[2]!).reasoning).toBeUndefined();
});

test("Anthropic runs one tool call per turn, and long silent turns are allowed", async () => {
  let body = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return new Response('data: {"type":"message_stop"}\n\n', { status: 200 });
  }) as unknown as typeof fetch;
  const model = anthropicModel({ model: "m", apiKey: async () => "k" }, fetchImpl);
  for await (const _ of model.turn({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [{ name: "t", description: "d", parameters: {} }] }, new AbortController().signal)) void _;
  expect(JSON.parse(body).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  expect(IDLE_MS).toBeGreaterThanOrEqual(300_000);
});

test("only visible fields decide whether a page is a password change", async () => {
  const { pageContext } = await import("../src/agent/tools");
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/login.html") }));
  expect(await pageContext(ctx)).toEqual({ payment: false, passwordChange: false });
  await runTool(ctx, call("navigate", { url: env.site.url("/newpass.html") }));
  expect(await pageContext(ctx)).toEqual({ payment: false, passwordChange: true });
  await ctx.close();
});

test("a checkbox under its own decoration clicks; a clipped button says so plainly", async () => {
  const tab = await env.browser.newTab(env.site.url("/login.html"));
  const snap = await snapshot(tab);
  expect(await click(tab, snap.refs, refOf(snap, 'checkbox "Search all releases"'))).toMatchObject({ ok: true });
  expect(await tab.evaluate<string>("document.getElementById('out').textContent")).toBe("all true");
  const clipped = await click(tab, snap.refs, refOf(snap, 'button "Clipped"'));
  expect(clipped).toEqual({ ok: false, error: "the element is hidden or clipped on screen; scroll its container or open the panel it is in" });
  await tab.close();
});
