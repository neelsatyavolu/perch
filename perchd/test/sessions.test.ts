import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import type { CallPolicy } from "../src/agent/session";
import type { Browser } from "../src/browser/browser";
import { SessionManager, type SessionInfo } from "../src/daemon/sessions";
import { setup, tempProfile } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
const scratch = tempProfile();
const sessionsFile = join(scratch.dir, "run", "sessions.json");
const groups: { ids: string[]; label: string }[] = [];
let manager: SessionManager;

beforeAll(async () => {
  env = await setup();
  manager = new SessionManager({
    browser: async () => env.browser as Browser,
    sessionsFile,
    groups: { apply: async (ids, label) => void groups.push({ ids, label }) },
  });
});
afterAll(async () => {
  await manager.closeAll();
  await env.teardown();
  scratch.cleanup();
});

const policy = (client: string): CallPolicy => ({ mode: "guard", audit: new AuditLog(join(scratch.dir, "audit.jsonl")), client, approve: async () => false });
const info = (client: string, session: string, agent: string, title: string): SessionInfo => ({ client, session, agent, title, persistent: true, onEnd: "close" });

test("each session works in its own tabs, labelled by agent and title", async () => {
  const claude = manager.open(info("claude-code", "s1", "Claude Code", "Fix login"));
  const codex = manager.open(info("codex", "s2", "Codex", "Docs"));
  expect(claude.label).toBe("Claude Code · Fix login");

  const a = await manager.call(claude, { id: "1", name: "navigate", args: { url: env.site.url("/mail.html") } }, policy("claude-code/s1"));
  expect(a.isError).toBeFalsy();
  const b = await manager.call(codex, { id: "2", name: "open_tab", args: { url: env.site.url("/form.html") } }, policy("codex/s2"));
  expect(b.isError).toBeFalsy();
  expect(groups.map((g) => g.label)).toEqual(expect.arrayContaining(["Claude Code · Fix login", "Codex · Docs"]));

  const listing = (await manager.call(claude, { id: "3", name: "tabs", args: {} }, policy("claude-code/s1"))).content;
  expect(listing).toMatch(/^\* [A-F0-9]{32} .*mail\.html/m);
  expect(listing).toContain("Codex · Docs");

  const codexTab = manager.get("codex", "s2")!.tabIds()[0]!;
  const refused = await manager.call(claude, { id: "4", name: "switch_tab", args: { id: codexTab } }, policy("claude-code/s1"));
  expect(refused).toEqual({ content: `That tab belongs to "Codex · Docs". Open your own with open_tab.`, isError: true });

  const file = JSON.parse(readFileSync(sessionsFile, "utf8"));
  expect(file.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ client: "claude-code", session: "s1", label: "Claude Code · Fix login", tabs: 1, asleep: false }),
      expect.objectContaining({ client: "codex", session: "s2", tabs: 1 }),
    ]),
  );
  expect(JSON.stringify(file)).not.toContain("mail.html");
  expect(statSync(sessionsFile).mode & 0o777).toBe(0o600);
}, 30_000);

test("a user's tab is borrowed by one session at a time and released at the end", async () => {
  const user = await env.browser.newTab(env.site.url("/news.html"));
  const claude = manager.get("claude-code", "s1")!;
  const codex = manager.get("codex", "s2")!;
  const taken = await manager.call(codex, { id: "5", name: "switch_tab", args: { id: user.id } }, policy("codex/s2"));
  expect(taken.isError).toBeFalsy();
  const blocked = await manager.call(claude, { id: "6", name: "switch_tab", args: { id: user.id } }, policy("claude-code/s1"));
  expect(blocked.content).toBe(`That tab belongs to "Codex · Docs". Open your own with open_tab.`);

  const codexOwn = codex.tabIds().filter((id) => id !== user.id);
  await manager.end(codex, "close");
  expect(manager.get("codex", "s2")).toBeUndefined();
  const open = (await env.browser.tabs()).map((t) => t.id);
  expect(open).toContain(user.id);
  for (const id of codexOwn) expect(open).not.toContain(id);
  const now = await manager.call(claude, { id: "7", name: "switch_tab", args: { id: user.id } }, policy("claude-code/s1"));
  expect(now.isError).toBeFalsy();
}, 30_000);

test("a session that ends asleep keeps its tabs and wakes on the next call", async () => {
  const claude = manager.get("claude-code", "s1")!;
  const own = claude.tabIds();
  await manager.end(claude, "sleep");
  expect(manager.list().find((s) => s.session === "s1")).toMatchObject({ asleep: true });
  const open = (await env.browser.tabs()).map((t) => t.id);
  for (const id of own) expect(open).toContain(id);

  const again = manager.open(info("claude-code", "s1", "Claude Code", "Fix login"));
  const r = await manager.call(again, { id: "8", name: "navigate", args: { url: env.site.url("/form.html") } }, policy("claude-code/s1"));
  expect(r.isError).toBeFalsy();
  expect(manager.list().find((s) => s.session === "s1")).toMatchObject({ asleep: false });
}, 30_000);

test("an ended persistent session is closed after its grace period unless it comes back", async () => {
  const s = manager.open({ ...info("grok", "g1", "Grok", "x"), onEnd: "close" });
  await manager.call(s, { id: "9", name: "open_tab", args: { url: env.site.url("/mail.html") } }, policy("grok/g1"));
  const tab = s.tabIds()[0]!;
  manager.scheduleEnd(s, 50);
  manager.open(info("grok", "g1", "Grok", "x"));
  await Bun.sleep(120);
  expect(manager.get("grok", "g1")).toBeDefined();
  manager.scheduleEnd(s, 50);
  await Bun.sleep(400);
  expect(manager.get("grok", "g1")).toBeUndefined();
  expect((await env.browser.tabs()).map((t) => t.id)).not.toContain(tab);
}, 30_000);
