/**
 * Smoke test: builds the pages, starts perchd's app API with a scripted runner as the backend,
 * and loads both pages in headless Chrome for Testing in every theme and accent. Any console
 * error, uncaught exception, CSP violation or failed load fails the test.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../../perchd/src/agent/loop";
import { startApp, type App } from "../../perchd/src/app/app";
import { memoryKeychain } from "../../perchd/src/app/keychain";
import type { Chat } from "../../perchd/src/app/protocol";
import type { RunnerInput } from "../../perchd/src/app/runs";
import { Vault } from "../../perchd/src/app/vault";
import { Browser } from "../../perchd/src/browser/browser";
import type { Tab } from "../../perchd/src/browser/tab";
import { ACCENTS, THEMES } from "../src/theme/names.gen";

const ROOT = join(import.meta.dir, "..");
let work: string;
let app: App;
let browser: Browser;
let tab: Tab;
let fullChatId: string;
const problems: string[] = [];

const REPLY = [
  "You have **9 active subscriptions**, $112.43 a month.",
  "",
  "| Plan | Cost |",
  "|---|---:|",
  "| Music | $10.99 |",
  "",
  '```artifact html "Subscriptions, last 12 months"',
  "<!doctype html><h1>Subscriptions</h1><script>document.body.append(' ok')</script>",
  "```",
  "",
  "```js",
  "const total = 112.43;",
  "```",
].join("\n");

/** Released by the queue test: the "Hold on" task waits for it. */
let releaseHold: (() => void) | null = null;

async function* runner(input: RunnerInput): AsyncIterable<StepEvent> {
  if (input.ask?.includes("Grade everyone")) {
    // A long reply that outgrows the view while steps keep coming.
    for (let i = 1; i <= 30; i++) {
      yield { type: "text", delta: `Checking group ${i} of 30 for a brainstorm doc and its members.\n\n` };
      yield { type: "step", ...(i === 30 ? { detail: "jensen huang bloomberg" } : {}), label: i === 30 ? `Search the web for "Jensen Huang last hours as Nvidia CEO Bloomberg interview transcript free version archive mirror without paywall full text 2026 november keynote remarks"` : `Find ${i}` };
      await Bun.sleep(15);
    }
    if (!input.signal.aborted) await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return;
  }
  if (input.ask?.includes("Hold on")) {
    if (!input.signal.aborted) await new Promise<void>((resolve) => {
      releaseHold = resolve;
      input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "final", text: "Held." };
    return;
  }
  yield { type: "step", label: "Opened mail.example" };
  if (input.task.includes("Reply to Maya")) {
    yield { type: "text", delta: "The reply is ready." };
    await input.approve({ call: { id: "c", name: "type", args: { ref: "e2", text: "Hi Maya, Thursday at 3 works.", submit: true } }, target: { role: "textbox", name: "Message" }, kind: "risky", site: "mail.example", summary: "" });
    yield { type: "final", text: "Sent." };
    return;
  }
  yield { type: "final", text: REPLY };
}

async function build(outDir: string): Promise<void> {
  const proc = Bun.spawn(["nice", "-n", "10", process.execPath, join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`vite build failed:\n${await new Response(proc.stderr).text()}`);
}

beforeAll(async () => {
  // This file talks to a real browser and real servers, not happy-dom's stand-ins.
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  work = mkdtempSync(join(tmpdir(), "perch-ui-smoke-"));
  await build(join(work, "dist"));
  app = await startApp({
    dataDir: join(work, "data"),
    vault: await Vault.open(memoryKeychain(), "Default"),
    runner,
    models: [{ id: "gpt-6-astra", label: "GPT-6 Astra", provider: "ChatGPT", efforts: ["low", "medium", "high"] }],
    allowedOrigins: [],
    uiDir: join(work, "dist"),
  });
  // A finished full-page chat with a table, code and an artifact.
  const full = await app.chats.create({ title: "Subscriptions from receipts", settings: { model: "gpt-6-astra" } });
  fullChatId = full.id;
  await app.runs.send(full.id, "What am I paying for every month?");
  await app.runs.idle();
  // A side chat waiting at an approval card.
  const side: Chat = await app.chats.create({ tab: { id: "smoke-tab", windowId: "w1" }, settings: { model: "gpt-6-astra" } });
  await app.windows.activate("w1", { id: "smoke-tab", windowId: "w1", title: "Inbox (3) · Mailroom", url: "https://mail.example/inbox" });
  await app.runs.send(side.id, "Reply to Maya", { id: "smoke-tab", windowId: "w1", title: "Inbox (3) · Mailroom", url: "https://mail.example/inbox" });
  for (let i = 0; i < 100 && app.runs.status(side.id) !== "waiting"; i++) await Bun.sleep(10);

  browser = await Browser.launch({ userDataDir: join(work, "profile") });
  tab = await browser.newTab();
  await tab.send("Log.enable");
  const conn = browser.conn;
  conn.on("Runtime.consoleAPICalled", (p: { type: string; args: { value?: unknown; description?: string }[] }, sid) => {
    if (sid === tab.session && (p.type === "error" || p.type === "warning" || p.type === "assert")) problems.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description).join(" ")}`);
  });
  conn.on("Runtime.exceptionThrown", (p: { exceptionDetails: { text: string; exception?: { description?: string } } }, sid) => {
    if (sid === tab.session) problems.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  });
  conn.on("Log.entryAdded", (p: { entry: { level: string; text: string; url?: string } }, sid) => {
    if (sid === tab.session && (p.entry.level === "error" || p.entry.level === "warning")) problems.push(`log.${p.entry.level}: ${p.entry.text} ${p.entry.url ?? ""}`);
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await app?.stop();
  rmSync(work, { recursive: true, force: true });
  GlobalRegistrator.register({ url: "http://127.0.0.1/ui/chat.html" });
});

/** With PERCH_SMOKE_SHOTS=<dir>, saves each page as a PNG for the design review (spec 6.9). */
async function shot(name: string): Promise<void> {
  const dir = process.env.PERCH_SMOKE_SHOTS;
  if (!dir) return;
  const { data } = await tab.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(dir, `${name}.png`), Buffer.from(data, "base64"));
}

async function waitFor(expression: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await tab.evaluate<boolean>(expression).catch(() => false)) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

const pairs = THEMES.map((t, i) => ({ theme: t, accent: ACCENTS[i % ACCENTS.length]! }));

for (const { theme, accent } of pairs) {
  test(`the sidebar renders in ${theme.id} with ${accent.id}, with no console errors`, async () => {
    problems.length = 0;
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false });
    await tab.navigate(`${app.server.url}/ui/sidebar.html?theme=${theme.id}&accent=${accent.id}#token=${app.token}&window=w1`);
    await waitFor(`!!document.querySelector('.side[data-ready] .approve .btn.primary')`);
    const seen = await tab.evaluate<{ bg: string; accent: string; confirm: string; chip: string; dot: boolean; url: string }>(`(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      confirm: document.querySelector('.approve .btn.primary').textContent,
      chip: document.querySelector('.chip-t').textContent,
      dot: !!document.querySelector('.side-h .dot:not(.live)'),
      url: location.href,
    }))()`);
    expect(seen.bg).toBe(hexToRgb(theme.canvas));
    expect(seen.accent.toUpperCase()).toBe(theme.dark ? accent.dark : accent.light);
    expect(seen.confirm).toBe("Send message");
    expect(seen.chip).toBe("Inbox (3) · Mailroom");
    expect(seen.dot).toBe(true);
    expect(seen.url).not.toContain(app.token);
    await shot(`sidebar-${theme.id}-${accent.id}`);
    expect(problems).toEqual([]);
  }, 30_000);

  test(`the full-page chat renders in ${theme.id} with ${accent.id}, artifact pane included, with no console errors`, async () => {
    problems.length = 0;
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await tab.navigate(`${app.server.url}/ui/chat.html?theme=${theme.id}&accent=${accent.id}&chat=${fullChatId}#token=${app.token}`);
    await waitFor(`!!document.querySelector('.full[data-ready] .reply .md-table') && !!document.querySelector('.chats .row.sel')`);
    await tab.evaluate(`document.querySelector('button.artifact-card').click()`);
    await waitFor(`!!document.querySelector('.art .art-frame')`);
    await Bun.sleep(300);
    const seen = await tab.evaluate<{ bg: string; title: string; frame: string; width: number }>(`(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      title: document.querySelector('.art-h .title').textContent,
      frame: new URL(document.querySelector('.art-frame').src).origin,
      width: document.querySelector('.art').getBoundingClientRect().width,
    }))()`);
    expect(seen.bg).toBe(hexToRgb(theme.canvas));
    expect(seen.title).toBe("Subscriptions, last 12 months");
    expect(seen.frame).toBe(app.artifactServer.origin);
    expect(seen.width).toBe(360);
    await shot(`chat-${theme.id}-${accent.id}`);
    expect(problems).toEqual([]);
  }, 30_000);
}

/** Opens a chat in the full page and waits until it has loaded, so typing is not reset by the load. */
async function openChat(chatId: string, title: string): Promise<void> {
  await tab.send("Page.navigate", { url: `${app.server.url}/ui/chat.html?chat=${chatId}#token=${app.token}` });
  await waitFor(`!!document.querySelector('.full[data-ready] .composer textarea') && document.body.innerText.includes(${JSON.stringify(title)})`);
  await Bun.sleep(100);
}

/** Types into the composer and presses Enter (with ⌘ to steer). */
async function typeAndEnter(text: string, meta = false): Promise<void> {
  await tab.evaluate(`(() => {
    const f = document.querySelector('.composer textarea');
    f.focus();
    f.value = ${JSON.stringify(text)};
    f.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await Bun.sleep(50);
  await tab.evaluate(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: ${meta}, bubbles: true }))`);
}

test("a reply that outgrows the view is followed, so its newest step stays in sight", async () => {
  problems.length = 0;
  const chat = await app.chats.create({ title: "Grades", settings: { model: "gpt-6-astra" } });
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  await openChat(chat.id, "Grades");
  await typeAndEnter("Grade everyone without a brainstorm doc");
  await waitFor(`[...document.querySelectorAll('.reply.live .step-l')].some((s) => s.textContent.startsWith('Search the web'))`);
  // A long step ends in an ellipsis inside the column instead of running off the side.
  const spill = await tab.evaluate<string[]>(`(() => {
    const thread = document.querySelector('.thread');
    const label = [...document.querySelectorAll('.reply.live .step-l')].find((s) => s.textContent.startsWith('Search the web'));
    if (!label) return ['no long step'];
    // Every box from the label up to the list either fits its text or clips it.
    const out = [];
    for (let el = label; el && el !== thread; el = el.parentElement) {
      for (const box of [el, ...el.querySelectorAll('*')]) {
        if (box.scrollWidth > box.clientWidth + 1 && getComputedStyle(box).overflowX === 'visible') out.push(box.className || box.tagName);
      }
      if (el.classList.contains('steplist')) break;
    }
    return [...new Set(out)];
  })()`);
  expect(spill).toEqual([]);
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 700, deviceScaleFactor: 2, mobile: false });
  await Bun.sleep(300);
  // Narrowing wraps the text taller; the view stays at the newest step.
  expect(await tab.evaluate<boolean>(`(() => {
    const thread = document.querySelector('.thread');
    const step = [...document.querySelectorAll('.reply.live .step-l')].at(-1);
    return step.getBoundingClientRect().bottom <= thread.getBoundingClientRect().bottom;
  })()`)).toBe(true);
  await shot("long-step-narrow");
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  // The newest step comes into view and stays there, with the view scrolled down to it.
  await waitFor(`(() => {
    const thread = document.querySelector('.thread');
    const step = [...document.querySelectorAll('.reply.live .step-l')].at(-1);
    return thread.scrollTop > 0 && step.getBoundingClientRect().bottom <= thread.getBoundingClientRect().bottom;
  })()`, 5000);
  app.runs.stop(chat.id);
  await app.runs.idleFor(chat.id);
  expect(problems).toEqual([]);
}, 30_000);

test("a message sent while a task runs waits above the composer, then goes out when the task ends", async () => {
  problems.length = 0;
  const chat = await app.chats.create({ title: "Queue", settings: { model: "gpt-6-astra" } });
  await openChat(chat.id, "Queue");
  await typeAndEnter("Hold on");
  await waitFor(`!!document.querySelector('.reply.live')`);
  await typeAndEnter("then export the CSV");
  await waitFor(`document.querySelector('.queued-t')?.textContent === 'then export the CSV'`);
  await shot("sidebar-queued");
  releaseHold?.();
  await waitFor(`!document.querySelector('.queued') && [...document.querySelectorAll('[data-id]')].some((m) => m.textContent.includes('then export the CSV'))`);
  await app.runs.idleFor(chat.id);
  const messages = app.chats.get(chat.id)!.messages;
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["Hold on", "then export the CSV"]);
  expect(problems).toEqual([]);
}, 30_000);
