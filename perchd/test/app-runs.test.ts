import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../src/agent/loop";
import type { ApprovalRequest } from "../src/agent/session";
import { ArtifactStore } from "../src/app/artifacts";
import { ChatStore } from "../src/app/chats";
import { memoryKeychain } from "../src/app/keychain";
import type { AppEvent } from "../src/app/protocol";
import { RunManager, type Runner, type RunnerInput } from "../src/app/runs";
import { Vault } from "../src/app/vault";

let dir: string;
let chats: ChatStore;
let artifacts: ArtifactStore;
let events: AppEvent[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-runs-"));
  const vault = await Vault.open(memoryKeychain(), "Default");
  chats = await ChatStore.load(join(dir, "chats"), vault);
  artifacts = await ArtifactStore.load(join(dir, "artifacts"), vault);
  events = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sendReq: ApprovalRequest = { call: { id: "c", name: "click", args: { ref: "e3" } }, target: { role: "button", name: "Send" }, kind: "risky", site: "mail.example", summary: 'Click button "Send" on mail.example' };

function manager(runner: Runner) {
  return new RunManager({ chats, artifacts, runner, emit: (e) => events.push(e), artifactUrl: (id, v) => `http://art/${id}/${v}`, tabs: () => [] });
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

test("text streams, steps collect and the reply is saved", async () => {
  let seen: RunnerInput | undefined;
  const runs = manager(async function* (input): AsyncIterable<StepEvent> {
    seen = input;
    yield { type: "text", delta: "Looking " };
    yield { type: "step", label: "Opened mail.example" };
    yield { type: "text", delta: "now." };
    yield { type: "final", text: "You have 3 unread emails." };
  });
  const chat = await chats.create({ settings: { mode: "ask", model: "fake", effort: "high" } });
  const { runId, message } = await runs.send(chat.id, "How many unread emails?");
  expect(message.role).toBe("user");
  await runs.idle();
  expect(seen!.settings).toMatchObject({ mode: "ask", model: "fake", effort: "high" });
  expect(seen!.task.trimEnd().endsWith("How many unread emails?")).toBe(true);
  expect(of("run.text").map((e) => e.delta).join("")).toBe("Looking now.");
  expect(of("run.step").map((e) => e.label)).toEqual(["Opened mail.example"]);
  const finished = of("run.finished")[0]!;
  expect(finished.runId).toBe(runId);
  expect(finished.message).toMatchObject({ role: "assistant", text: "You have 3 unread emails.", steps: ["Opened mail.example"] });
  const saved = chats.get(chat.id)!;
  expect(saved.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(saved.title).toBe("How many unread emails?");
  expect(runs.status(chat.id)).toBe("idle");
});

test("an approval waits for the user and the card names the action", async () => {
  let answer: boolean | undefined;
  const runs = manager(async function* (input) {
    yield { type: "approval", request: sendReq };
    answer = await input.approve(sendReq);
    yield { type: "final", text: answer ? "Sent." : "Not sent." };
  });
  const chat = await chats.create({});
  await runs.send(chat.id, "Reply to Maya");
  const ask = await waitFor(() => of("run.approval")[0]);
  expect(ask.card).toMatchObject({ confirm: "Send", site: "mail.example", chatId: chat.id });
  expect(runs.status(chat.id)).toBe("waiting");
  expect(runs.snapshot(chat.id)?.approval?.id).toBe(ask.card.id);
  expect(runs.decide("not-an-id", true)).toBe(false);
  expect(runs.decide(ask.card.id, true)).toBe(true);
  await runs.idle();
  expect(answer).toBe(true);
  expect(of("run.approval.resolved")[0]).toMatchObject({ approvalId: ask.card.id, approved: true });
  expect(chats.get(chat.id)!.messages.at(-1)!.text).toBe("Sent.");
});

test("cancel stops the run, declines a waiting approval and marks the reply stopped", async () => {
  let answer: boolean | undefined;
  const runs = manager(async function* (input) {
    yield { type: "text", delta: "Working" };
    answer = await input.approve(sendReq);
    if (input.signal.aborted) {
      yield { type: "error", message: "Cancelled." };
      return;
    }
    yield { type: "final", text: "should not happen" };
  });
  const chat = await chats.create({});
  await runs.send(chat.id, "Go");
  await waitFor(() => of("run.approval")[0]);
  expect(runs.cancel(chat.id)).toBe(true);
  await runs.idle();
  expect(answer).toBe(false);
  const reply = chats.get(chat.id)!.messages.at(-1)!;
  expect(reply).toMatchObject({ role: "assistant", stopped: true, text: "Working" });
  expect(reply.error).toBeUndefined();
  expect(runs.cancel(chat.id)).toBe(false);
});

test("a second message is refused while the first run is going, and accepted after", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runs = manager(async function* () {
    await gate;
    yield { type: "final", text: "done" };
  });
  const chat = await chats.create({});
  await runs.send(chat.id, "first");
  await expect(runs.send(chat.id, "second")).rejects.toThrow(/still running/);
  release();
  await runs.idle();
  await runs.send(chat.id, "second");
  await runs.idle();
  expect(chats.get(chat.id)!.messages.map((m) => m.text)).toEqual(["first", "done", "second", "done"]);
});

test("earlier turns reach the next task", async () => {
  const tasks: string[] = [];
  const runs = manager(async function* (input) {
    tasks.push(input.task);
    yield { type: "final", text: `answer ${tasks.length}` };
  });
  const chat = await chats.create({});
  await runs.send(chat.id, "question one");
  await runs.idle();
  await runs.send(chat.id, "question two");
  await runs.idle();
  expect(tasks[1]).toContain("User: question one");
  expect(tasks[1]).toContain("Perch: answer 1");
});

test("artifact blocks in the reply are saved and replaced by markers", async () => {
  const runs = manager(async function* () {
    yield { type: "final", text: 'Here it is.\n```artifact markdown "Packing list"\n- passport\n```\nAnything else?' };
  });
  const chat = await chats.create({});
  await runs.send(chat.id, "Make a packing list");
  await runs.idle();
  const saved = of("artifact.saved");
  expect(saved).toHaveLength(1);
  expect(saved[0]!.artifact).toMatchObject({ title: "Packing list", kind: "markdown", version: 1, versions: 1 });
  expect(saved[0]!.artifact.url).toBe(`http://art/${saved[0]!.artifact.id}/1`);
  const reply = chats.get(chat.id)!.messages.at(-1)!;
  expect(reply.text).toBe(`Here it is.\n[[artifact:${saved[0]!.artifact.id}]]\nAnything else?`);
  expect(reply.artifacts).toEqual([saved[0]!.artifact.id]);
});

test("a runner that throws ends the run with a plain error", async () => {
  const runs = manager(async function* () {
    yield { type: "text", delta: "" };
    throw new Error("Model sign-in expired. Sign in again in Settings → Models.");
  });
  const chat = await chats.create({});
  await runs.send(chat.id, "Hi");
  await runs.idle();
  expect(chats.get(chat.id)!.messages.at(-1)).toMatchObject({ error: "Model sign-in expired. Sign in again in Settings → Models." });
  expect(runs.status(chat.id)).toBe("idle");
});

test("empty or oversized messages and unknown chats are refused", async () => {
  const runs = manager(async function* () {
    yield { type: "final", text: "x" };
  });
  const chat = await chats.create({});
  await expect(runs.send(chat.id, "   ")).rejects.toThrow(/empty/);
  await expect(runs.send(chat.id, "x".repeat(50_001))).rejects.toThrow(/too long/);
  await expect(runs.send("nope", "hi")).rejects.toThrow(/no chat/);
});

test("summaries carry the run status for the perch dot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runs = manager(async function* () {
    await gate;
    yield { type: "final", text: "ok" };
  });
  const chat = await chats.create({});
  await runs.send(chat.id, "Wait for it");
  expect(runs.summary(chats.get(chat.id)!)).toMatchObject({ status: "running", preview: "Wait for it" });
  release();
  await runs.idle();
  expect(runs.summary(chats.get(chat.id)!)).toMatchObject({ status: "idle", preview: "ok" });
});

test("idleFor waits for one chat's run and not for another chat that is waiting at an approval", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runs = manager(async function* (input) {
    if (input.task.includes("approve")) {
      await input.approve(sendReq);
      yield { type: "final", text: "sent" };
      return;
    }
    await gate;
    yield { type: "final", text: "done" };
  });
  const waiting = await chats.create({});
  const quick = await chats.create({});
  await runs.send(waiting.id, "approve this");
  await waitFor(() => of("run.approval")[0]);
  await runs.send(quick.id, "first");
  release();
  const outcome = await Promise.race([runs.idleFor(quick.id).then(() => "idle"), Bun.sleep(1000).then(() => "hung")]);
  expect(outcome).toBe("idle");
  expect(runs.status(quick.id)).toBe("idle");
  expect(runs.status(waiting.id)).toBe("waiting");
  runs.cancel(waiting.id);
  await runs.idle();
});
