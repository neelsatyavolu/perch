import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../src/agent/loop";
import type { ApprovalRequest } from "../src/agent/session";
import { ArtifactStore } from "../src/app/artifacts";
import { ChatStore } from "../src/app/chats";
import { memoryKeychain } from "../src/app/keychain";
import type { AppEvent, ChatStatus } from "../src/app/protocol";
import { RunManager, type Runner } from "../src/app/runs";
import { Vault } from "../src/app/vault";

let dir: string;
let chats: ChatStore;
let artifacts: ArtifactStore;
let events: AppEvent[];
let statuses: [ChatStatus, string | null][];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-held-"));
  const vault = await Vault.open(memoryKeychain(), "Default");
  chats = await ChatStore.load(join(dir, "chats"), vault);
  artifacts = await ArtifactStore.load(join(dir, "artifacts"), vault);
  events = [];
  statuses = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sendReq: ApprovalRequest = { call: { id: "c", name: "click", args: { ref: "e3" } }, target: { role: "button", name: "Send" }, kind: "risky", site: "mail.example", summary: 'Click button "Send" on mail.example' };
const settings = { mode: "guard", model: "fake", effort: "high" } as const;

function manager(runner: Runner) {
  return new RunManager({
    chats, artifacts, runner, emit: (e) => events.push(e), artifactUrl: (id, v) => `http://art/${id}/${v}`, tabs: () => [],
    onStatus: (_, status, card) => statuses.push([status, card?.title ?? null]),
  });
}

const of = <T extends AppEvent["type"]>(type: T) => events.filter((e): e is Extract<AppEvent, { type: T }> => e.type === type);
async function waitFor<T>(check: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

test("status changes reach onStatus: running, waiting with its card, then idle", async () => {
  let chatId: string | undefined;
  const runs = manager(async function* (input): AsyncIterable<StepEvent> {
    chatId = input.chatId;
    await input.approve(sendReq);
    yield { type: "final", text: "done" };
  });
  const chat = await chats.create({ settings });
  await runs.send(chat.id, "send it");
  const card = await waitFor(() => of("run.approval")[0]?.card);
  runs.decide(card.id, true);
  await runs.idle();
  expect(chatId).toBe(chat.id);
  expect(statuses[0]).toEqual(["running", null]);
  expect(statuses).toContainEqual(["waiting", card.title]);
  expect(statuses.at(-1)).toEqual(["idle", null]);
});

test("a held card waits in a chat with no run, answers once, and shows in the snapshot", async () => {
  const runs = manager(async function* () {});
  const chat = await chats.create({ title: "Codex · perch", settings });
  const answer = runs.hold(chat.id, { title: "Allow Codex to use Perch in Guard mode", site: "", kind: "change", confirm: "Allow Codex", danger: false });
  const card = await waitFor(() => of("run.approval")[0]?.card);
  expect(runs.status(chat.id)).toBe("waiting");
  expect(runs.snapshot(chat.id)?.approval?.id).toBe(card.id);
  expect(statuses).toContainEqual(["waiting", "Allow Codex to use Perch in Guard mode"]);
  expect(runs.decide(card.id, true)).toBe(true);
  expect(await answer).toBe(true);
  expect(runs.decide(card.id, false)).toBe(false);
  expect(runs.status(chat.id)).toBe("idle");
});

test("a second held card waits for the first", async () => {
  const runs = manager(async function* () {});
  const chat = await chats.create({ settings });
  const first = runs.hold(chat.id, { title: "One", site: "", kind: "change", confirm: "One", danger: false });
  const second = runs.hold(chat.id, { title: "Two", site: "", kind: "change", confirm: "Two", danger: false });
  const a = await waitFor(() => of("run.approval")[0]?.card);
  expect(of("run.approval").length).toBe(1);
  runs.decide(a.id, false);
  const b = await waitFor(() => of("run.approval")[1]?.card);
  expect(b.title).toBe("Two");
  runs.decide(b.id, true);
  expect([await first, await second]).toEqual([false, true]);
});

test("a held card is declined when its signal aborts", async () => {
  const runs = manager(async function* () {});
  const chat = await chats.create({ settings });
  const stop = new AbortController();
  const answer = runs.hold(chat.id, { title: "Click", site: "x", kind: "risky", confirm: "Click", danger: false }, stop.signal);
  await waitFor(() => of("run.approval")[0]);
  stop.abort();
  expect(await answer).toBe(false);
  expect(of("run.approval.resolved")[0]?.approved).toBe(false);
});
