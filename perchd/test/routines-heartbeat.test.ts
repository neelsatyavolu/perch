import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import type { StepEvent } from "../src/agent/loop";
import { startApp, type App } from "../src/app/app";
import { wakeChat } from "../src/app/heartbeat";
import { memoryKeychain } from "../src/app/keychain";
import type { RunnerInput } from "../src/app/runs";
import { Vault } from "../src/app/vault";
import { mockKeychain } from "../src/memory/keychain";
import { createRoutinesApi } from "../src/routines/api";
import { runRoutine, type RunnerDeps } from "../src/routines/runner";
import { Scheduler } from "../src/routines/scheduler";
import { RoutineStore, type Routine } from "../src/routines/store";

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "perch-heartbeat-"));
  dirs.push(d);
  return d;
};

const CHAT = "6f1c0a52-8e0b-4f1e-9a43-0f3d2b7c9d11";
const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "0123456789abcdef0123456789abcdef",
  name: "Check the parcel",
  task: "Has the parcel shipped yet?",
  schedule: { kind: "interval", hours: 4 },
  enabled: true,
  mode: "guard",
  missed: "skip",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  lastRunAt: null,
  nextRunAt: null,
  wake: { chatId: CHAT },
  ...over,
});

async function app(runner: (input: RunnerInput) => AsyncIterable<StepEvent>): Promise<App> {
  const a = await startApp({ dataDir: temp(), vault: await Vault.open(memoryKeychain(), "Default"), runner, models: [{ id: "fake", label: "Fake", provider: "t", efforts: ["medium"] }], allowedOrigins: [] });
  apps.push(a);
  return a;
}

test("a heartbeat routine wakes its chat instead of opening a new one", async () => {
  const store = await RoutineStore.open(temp(), mockKeychain(), "default");
  await store.save(routine());
  const woke: string[] = [];
  const deps: RunnerDeps = {
    store,
    audit: new AuditLog(join(temp(), "audit.jsonl")),
    browser: async () => Promise.reject(new Error("a heartbeat does not open a browser here")),
    model: async () => Promise.reject(new Error("nor a model")),
    wakeChat: async (chatId, task) => {
      woke.push(`${chatId}:${task}`);
      return { status: "ok", answer: "Shipped on Tuesday." };
    },
  };
  const record = await runRoutine(routine(), "schedule", deps);
  expect(woke).toEqual([`${CHAT}:Has the parcel shipped yet?`]);
  expect(record).toMatchObject({ status: "ok", answer: "Shipped on Tuesday.", chatId: null, wokeChat: CHAT });
  expect((await store.runs(routine().id, 10)).length).toBe(1);
});

test("without chats to wake, a heartbeat run fails plainly", async () => {
  const store = await RoutineStore.open(temp(), mockKeychain(), "default");
  const record = await runRoutine(routine(), "schedule", { store, audit: new AuditLog(join(temp(), "a.jsonl")), browser: async () => Promise.reject(new Error("x")), model: async () => Promise.reject(new Error("x")) });
  expect(record.status).toBe("error");
  expect(record.answer).toContain("chat");
});

test("waking a chat sends the task there and returns the chat's answer", async () => {
  const a = await app(async function* (input) {
    yield { type: "final", text: `Answer to: ${input.task.split("\n").at(-1)}` };
  });
  const chat = await a.chats.create({ title: "Parcel" });
  const result = await wakeChat(a, chat.id, "Has the parcel shipped yet?");
  expect(result.status).toBe("ok");
  expect(result.answer).toContain("Has the parcel shipped yet?");
  expect(a.chats.get(chat.id)!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("a deleted, private or busy chat is not woken", async () => {
  let release: () => void = () => {};
  const a = await app(async function* () {
    await new Promise<void>((r) => (release = r));
    yield { type: "final", text: "done" };
  });
  expect((await wakeChat(a, CHAT, "x")).status).toBe("error");
  const priv = await a.chats.create({ incognito: true });
  expect((await wakeChat(a, priv.id, "x")).status).toBe("error");
  const busy = await a.chats.create({});
  await a.runs.send(busy.id, "first");
  expect((await wakeChat(a, busy.id, "second")).status).toBe("skipped");
  release();
  await a.runs.idleFor(busy.id);
});

test("stopping the routine's run stops the chat's task", async () => {
  const a = await app(async function* (input) {
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
    yield { type: "final", text: "late" };
  });
  const chat = await a.chats.create({});
  const stop = new AbortController();
  const pending = wakeChat(a, chat.id, "wait", stop.signal);
  await Bun.sleep(10);
  stop.abort();
  expect((await pending).status).toBe("cancelled");
});

test("the routines API takes the chat a routine wakes", async () => {
  const store = await RoutineStore.open(temp(), mockKeychain(), "default");
  const scheduler = new Scheduler({ store, run: async () => Promise.reject(new Error("not run")) });
  const api = createRoutinesApi({ store, scheduler });
  const made = await api.create({ name: "Parcel", task: "Shipped?", schedule: { kind: "interval", hours: 4 }, wakeChatId: CHAT });
  expect(made.ok && made.data.wake).toEqual({ chatId: CHAT });
  const bad = await api.create({ name: "Parcel", task: "Shipped?", schedule: { kind: "interval", hours: 4 }, wakeChatId: "../x" });
  expect(bad.ok).toBe(false);
});
