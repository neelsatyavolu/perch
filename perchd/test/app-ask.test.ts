import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../src/agent/loop";
import type { ApprovalRequest } from "../src/agent/session";
import { ArtifactStore } from "../src/app/artifacts";
import { askFromBrowser } from "../src/app/ask";
import { ChatStore } from "../src/app/chats";
import { memoryKeychain } from "../src/app/keychain";
import { OutsideApprovals } from "../src/app/outside-approvals";
import type { AppEvent, TabInfo } from "../src/app/protocol";
import { RunManager, type RunnerInput } from "../src/app/runs";
import { Vault } from "../src/app/vault";

let dir: string;
let chats: ChatStore;
let artifacts: ArtifactStore;
let events: AppEvent[];
let inputs: RunnerInput[];
let reveals: unknown[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-ask-"));
  const vault = await Vault.open(memoryKeychain(), "Default");
  chats = await ChatStore.load(join(dir, "chats"), vault);
  artifacts = await ArtifactStore.load(join(dir, "artifacts"), vault);
  events = [];
  inputs = [];
  reveals = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const defaults = () => ({ mode: "guard", model: "fake", effort: "medium", scope: "current" }) as const;
const perch = { revealChat: async (p: unknown) => (reveals.push(p), {}) };
const tabA: TabInfo = { id: "guid-a", windowId: "w1", title: "Docs", url: "https://docs.example/", targetId: "T-A" };

function runs() {
  return new RunManager({
    chats, artifacts, emit: (e) => events.push(e), artifactUrl: () => "", tabs: () => [tabA],
    runner: async function* (input): AsyncIterable<StepEvent> {
      inputs.push(input);
      yield { type: "final", text: "ok" };
    },
  });
}

test("Ask on a tab starts that tab's side chat, reveals it in the side panel, and works in the tab", async () => {
  const r = runs();
  const result = await askFromBrowser({ chats, runs: r, tab: (id) => (id === tabA.id ? tabA : undefined), defaults, perch }, { text: "summarise this", tabId: tabA.id });
  await r.idle();
  expect(result.started).toBe(true);
  expect(chats.forTab(tabA.id)?.id).toBe(result.chatId);
  // The side panel opens on the tab the browser knows by its DevTools target id.
  expect(reveals).toEqual([{ chatId: result.chatId, mode: "side", tabId: "T-A" }]);
  expect(inputs[0]?.tab?.targetId).toBe("T-A");
  // A second Ask on the same tab reuses its side chat.
  const again = await askFromBrowser({ chats, runs: r, tab: () => tabA, defaults, perch }, { text: "and the next one", tabId: tabA.id });
  expect(again.chatId).toBe(result.chatId);
  await r.idle();
});

test("Ask with no tab opens a full-page chat", async () => {
  const r = runs();
  const result = await askFromBrowser({ chats, runs: r, tab: () => undefined, defaults, perch }, { text: "plan a trip" });
  await r.idle();
  expect(chats.get(result.chatId)?.tab).toBeNull();
  expect(reveals).toEqual([{ chatId: result.chatId, mode: "full" }]);
});

test("Ask from a new tab opens a full chat, since there is no page to sit beside", async () => {
  const r = runs();
  const ntp: TabInfo = { ...tabA, id: "guid-n", url: "chrome://perch-newtab/", targetId: "T-N" };
  const result = await askFromBrowser({ chats, runs: r, tab: () => ntp, defaults, perch }, { text: "plan a trip", tabId: "T-N" });
  await r.idle();
  expect(reveals).toEqual([{ chatId: result.chatId, mode: "full" }]);
});

const sendReq: ApprovalRequest = { call: { id: "c", name: "click", args: { ref: "e3" } }, target: { role: "button", name: "Send" }, kind: "risky", site: "mail.example", summary: 'Click button "Send" on mail.example' };

test("an outside agent's action waits on a card in its own chat, revealed once, with its tabs as targets", async () => {
  const r = runs();
  const outside = new OutsideApprovals({ chats, runs: r, defaults, perch });
  const answer = outside.approve("Codex · perch", sendReq, () => ["T-9"]);
  for (let i = 0; i < 100 && !events.some((e) => e.type === "run.approval"); i++) await Bun.sleep(5);
  const card = (events.find((e) => e.type === "run.approval") as Extract<AppEvent, { type: "run.approval" }>).card;
  expect(chats.get(card.chatId)?.title).toBe("Codex · perch");
  expect(card.confirm).toBe("Send");
  expect(outside.targets(card.chatId)).toEqual(["T-9"]);
  expect(reveals).toEqual([{ chatId: card.chatId, mode: "full" }]);
  r.decide(card.id, true);
  expect(await answer).toBe(true);
});

test("an outside agent's steps show in its own chat from the first one, with its tabs as targets", async () => {
  const r = runs();
  const outside = new OutsideApprovals({ chats, runs: r, defaults, perch });
  await outside.observe("Claude Code · repo", () => ["T-7"], { label: "Open example.com" });
  await outside.observe("Claude Code · repo", () => ["T-7", "T-8"], { label: "Read the page" });
  for (let i = 0; i < 100 && !events.some((e) => e.type === "run.started"); i++) await Bun.sleep(5);
  const started = events.find((e) => e.type === "run.started") as Extract<AppEvent, { type: "run.started" }>;
  const chat = chats.get(started.chatId)!;
  expect(chat.title).toBe("Claude Code · repo");
  expect(chat.messages.at(-1)?.text).toBe("Claude Code · repo is working in Perch");
  expect(r.snapshot(chat.id)?.steps.map((s) => s.label)).toEqual(["Open example.com", "Read the page"]);
  expect(r.status(chat.id)).toBe("running");
  // Clicking any of its tabs finds this chat (agentChatFor uses these targets).
  expect(outside.targets(chat.id)).toEqual(["T-7", "T-8"]);
  // Stop closes the list now, saved with the chat like any run.
  expect(r.stop(chat.id).stopped).toBe(true);
  for (let i = 0; i < 100 && r.status(chat.id) !== "idle"; i++) await Bun.sleep(5);
  expect(chats.get(chat.id)!.messages.at(-1)?.text).toBe("Finished 2 steps in Perch.");
});

test("a new client's first connection becomes a card naming the client and Guard mode", async () => {
  const r = runs();
  const outside = new OutsideApprovals({ chats, runs: r, defaults, perch });
  const answer = outside.allowClient("codex");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "run.approval"); i++) await Bun.sleep(5);
  const card = (events.find((e) => e.type === "run.approval") as Extract<AppEvent, { type: "run.approval" }>).card;
  expect(card.title).toBe("Allow codex to use Perch in Guard mode");
  expect(card.confirm).toBe("Allow codex");
  r.decide(card.id, false);
  expect(await answer).toBe(false);
});

test("a login typed into a sign-in card reaches the call that asked, once; a declined card keeps nothing", async () => {
  const { takeTypedLogin } = await import("../src/agent/typed-logins");
  const r = runs();
  const chat = await chats.create({ settings: defaults() });
  const card = { title: "Sign in to account.proton.me", site: "account.proton.me", kind: "risky" as const, confirm: "Sign in", danger: false, login: { loginKey: "call-7" } };
  const answer = r.hold(chat.id, card);
  for (let i = 0; i < 100 && !events.some((e) => e.type === "run.approval"); i++) await Bun.sleep(5);
  const shown = (events.findLast((e) => e.type === "run.approval") as Extract<AppEvent, { type: "run.approval" }>).card;
  expect(JSON.stringify(events)).not.toContain("hunter2");
  expect(r.decide(shown.id, true, { username: "grace@example.com", password: "hunter2" })).toBe(true);
  expect(await answer).toBe(true);
  expect(JSON.stringify(events)).not.toContain("hunter2");
  expect(takeTypedLogin("call-7")).toEqual({ username: "grace@example.com", password: "hunter2" });
  expect(takeTypedLogin("call-7")).toBeUndefined();

  const declined = r.hold(chat.id, { ...card, login: { loginKey: "call-8" } });
  for (let i = 0; i < 100 && events.filter((e) => e.type === "run.approval").length < 2; i++) await Bun.sleep(5);
  const second = (events.findLast((e) => e.type === "run.approval") as Extract<AppEvent, { type: "run.approval" }>).card;
  r.decide(second.id, false, { username: "x", password: "y" });
  expect(await declined).toBe(false);
  expect(takeTypedLogin("call-8")).toBeUndefined();
});
