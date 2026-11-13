import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../src/agent/loop";
import { ArtifactStore } from "../src/app/artifacts";
import { ChatStore } from "../src/app/chats";
import { memoryKeychain } from "../src/app/keychain";
import type { AppEvent } from "../src/app/protocol";
import { RunManager, type RunnerInput } from "../src/app/runs";
import { Vault } from "../src/app/vault";

let dir: string;
let chats: ChatStore;
let artifacts: ArtifactStore;
let events: AppEvent[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-queue-"));
  const vault = await Vault.open(memoryKeychain(), "Default");
  chats = await ChatStore.load(join(dir, "chats"), vault);
  artifacts = await ArtifactStore.load(join(dir, "artifacts"), vault);
  events = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A runner whose turns end only when released, each answering with the user's message. */
function gated() {
  const gates: (() => void)[] = [];
  const asks: string[] = [];
  const runs = new RunManager({
    chats,
    artifacts,
    emit: (e) => events.push(e),
    artifactUrl: (id, v) => `http://art/${id}/${v}`,
    tabs: () => [],
    runner: async function* (input: RunnerInput): AsyncIterable<StepEvent> {
      asks.push(input.ask ?? "");
      yield { type: "step", label: `working on ${input.ask}` };
      await new Promise<void>((resolve) => {
        gates.push(resolve);
        input.signal.addEventListener("abort", () => {
          gates.splice(gates.indexOf(resolve), 1);
          resolve();
        }, { once: true });
      });
      if (input.signal.aborted) return;
      yield { type: "final", text: `done: ${input.ask}` };
    },
  });
  const release = async () => {
    const before = asks.length;
    gates.shift()?.();
    await Bun.sleep(30);
    return asks.length > before;
  };
  return { runs, asks, release };
}

const settled = () => Bun.sleep(30);
const lastQueue = () => events.filter((e): e is Extract<AppEvent, { type: "run.queue" }> => e.type === "run.queue").at(-1)?.queued ?? [];

test("messages sent while a task runs wait, then go out in order, each as its own turn", async () => {
  const { runs, asks, release } = gated();
  const chat = await chats.create({});
  await runs.enqueue(chat.id, "find the groups");
  await settled();
  const a = await runs.enqueue(chat.id, "also check cycle 2");
  const b = await runs.enqueue(chat.id, "then save");
  expect("queued" in a && "queued" in b).toBe(true);
  expect(lastQueue().map((q) => q.text)).toEqual(["also check cycle 2", "then save"]);
  expect(runs.snapshot(chat.id)?.queued?.map((q) => q.text)).toEqual(["also check cycle 2", "then save"]);
  await release();
  expect(asks).toEqual(["find the groups", "also check cycle 2"]);
  expect(lastQueue().map((q) => q.text)).toEqual(["then save"]);
  await release();
  await release();
  await runs.idle();
  expect(asks).toEqual(["find the groups", "also check cycle 2", "then save"]);
  expect(chats.get(chat.id)!.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
    "user:find the groups", "assistant:done: find the groups",
    "user:also check cycle 2", "assistant:done: also check cycle 2",
    "user:then save", "assistant:done: then save",
  ]);
});

test("steering stops the task where it is and sends the new message now; the queue follows it", async () => {
  const { runs, asks, release } = gated();
  const chat = await chats.create({});
  await runs.send(chat.id, "zero everyone without a doc");
  await settled();
  await runs.enqueue(chat.id, "then export the CSV");
  await runs.steer(chat.id, "only count approved pitches");
  await settled();
  expect(asks).toEqual(["zero everyone without a doc", "only count approved pitches"]);
  const messages = chats.get(chat.id)!.messages;
  expect(messages[1]).toMatchObject({ role: "assistant", stopped: true, steps: [{ label: "working on zero everyone without a doc" }] });
  expect(messages[2]).toMatchObject({ role: "user", text: "only count approved pitches" });
  expect(lastQueue().map((q) => q.text)).toEqual(["then export the CSV"]);
  await release();
  expect(asks.at(-1)).toBe("then export the CSV");
  await release();
  await runs.idle();
});

test("a queued message can be sent now or removed", async () => {
  const { runs, asks } = gated();
  const chat = await chats.create({});
  await runs.send(chat.id, "first");
  await settled();
  const one = await runs.enqueue(chat.id, "one");
  const two = await runs.enqueue(chat.id, "two");
  if (!("queued" in one) || !("queued" in two)) throw new Error("not queued");
  expect(runs.unqueue(chat.id, one.queued.id)).toBe(true);
  expect(runs.unqueue(chat.id, one.queued.id)).toBe(false);
  await runs.steerQueued(chat.id, two.queued.id);
  await settled();
  expect(asks).toEqual(["first", "two"]);
  expect(runs.queued(chat.id)).toEqual([]);
  runs.cancel(chat.id);
  await runs.idle();
});

test("Stop sends nothing that was waiting and hands its text back", async () => {
  const { runs, asks } = gated();
  const chat = await chats.create({});
  await runs.send(chat.id, "first");
  await settled();
  await runs.enqueue(chat.id, "second");
  await runs.enqueue(chat.id, "third");
  expect(runs.stop(chat.id)).toEqual({ stopped: true, unsent: ["second", "third"] });
  await runs.idle();
  await settled();
  expect(asks).toEqual(["first"]);
  expect(lastQueue()).toEqual([]);
});

test("with nothing running, a queued message goes out at once; the queue has a limit", async () => {
  const { runs, asks } = gated();
  const chat = await chats.create({});
  const sent = await runs.enqueue(chat.id, "go");
  expect("runId" in sent).toBe(true);
  await settled();
  expect(asks).toEqual(["go"]);
  for (let i = 0; i < 10; i++) await runs.enqueue(chat.id, `later ${i}`);
  expect(runs.enqueue(chat.id, "one too many")).rejects.toThrow("At most 10");
  runs.stop(chat.id);
  await runs.idle();
});
