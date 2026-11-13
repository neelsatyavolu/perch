import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../src/agent/loop";
import { ArtifactStore } from "../src/app/artifacts";
import { ChatStore } from "../src/app/chats";
import { memoryKeychain } from "../src/app/keychain";
import type { AppInfo, ChatSettings } from "../src/app/protocol";
import { RunManager, type Runner, type RunnerInput } from "../src/app/runs";
import { Tasks } from "../src/app/tasks";
import { Vault } from "../src/app/vault";
import { parseDuration } from "../src/cli/tasks";
import { parseExecArgs } from "../src/exec";

let dir: string;
let chats: ChatStore;
let artifacts: ArtifactStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-tasks-"));
  const vault = await Vault.open(memoryKeychain(), "Default");
  chats = await ChatStore.load(join(dir, "chats"), vault);
  artifacts = await ArtifactStore.load(join(dir, "artifacts"), vault);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const defaults: ChatSettings = { mode: "guard", model: "claude-code:claude-sonnet-5-5", effort: "medium", scope: "current" };
const info = (): AppInfo => ({
  models: [
    { id: "claude-code:claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "Claude Code", efforts: ["low", "medium", "high"] },
    { id: "codex:gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "Codex", efforts: ["low", "medium", "high"] },
  ],
  defaults,
  artifactOrigin: "",
});

function setup(runner: Runner) {
  const runs = new RunManager({ chats, artifacts, runner, emit: () => undefined, artifactUrl: (id, v) => `http://art/${id}/${v}`, tabs: () => [] });
  return { runs, tasks: new Tasks({ chats, runs, info }) };
}

/** A runner that answers with the task's last line, after `release` is called when gated. */
function echo(gate?: Promise<void>): { runner: Runner; seen: RunnerInput[] } {
  const seen: RunnerInput[] = [];
  return {
    seen,
    runner: async function* (input): AsyncIterable<StepEvent> {
      seen.push(input);
      yield { type: "step", label: "Opened example.com" };
      if (gate) await Promise.race([gate, new Promise((r) => input.signal.addEventListener("abort", r))]);
      if (input.signal.aborted) return;
      yield { type: "final", text: `Answer to: ${input.task.trim().split("\n").at(-1)}` };
    },
  };
}

test("a task is a chat tagged with its client, using the chosen model, effort and mode", async () => {
  const { runner, seen } = echo();
  const { runs, tasks } = setup(runner);
  const started = await tasks.start({ client: "cli", clientMode: "guard", task: "Find the price", model: "openai/gpt-6.1-sol", effort: "high", mode: "ask" });
  expect(started.status).toBe("running");
  await runs.idle();
  expect(seen[0]!.settings).toMatchObject({ model: "codex:gpt-6.1-sol", effort: "high", mode: "ask", scope: "agent" });
  const done = tasks.get("cli", started.id);
  expect(done).toMatchObject({ status: "done", answer: "Answer to: Find the price", steps: ["Opened example.com"], turns: 1 });
  expect(chats.get(started.id)!.origin).toBe("cli");
});

test("a client sees only its own tasks, and ids can be shortened", async () => {
  const { runs, tasks } = setup(echo().runner);
  const mine = await tasks.start({ client: "cli", clientMode: "guard", task: "One" });
  await tasks.start({ client: "codex", clientMode: "guard", task: "Two" });
  await chats.create({ settings: defaults });
  await runs.idle();
  expect(tasks.list("cli").map((t) => t.id)).toEqual([mine.id]);
  expect(tasks.get("cli", mine.id.slice(0, 8)).id).toBe(mine.id);
  expect(() => tasks.get("codex", mine.id)).toThrow(/No task/);
});

test("a task's effort is fitted to its model when it runs", async () => {
  const { runner, seen } = echo();
  const { runs, tasks } = setup(runner);
  const started = await tasks.start({ client: "cli", clientMode: "guard", task: "x", model: "codex:gpt-6.1-sol", effort: "ultra" });
  await runs.idle();
  expect(started.id).toBeTruthy();
  expect(seen[0]!.settings.effort).toBe("ultra");
});

test("a task cannot run in a freer mode than its client", async () => {
  const { tasks } = setup(echo().runner);
  await expect(tasks.start({ client: "cli", clientMode: "guard", task: "Pay it", mode: "full-access" })).rejects.toThrow(/at most guard/);
  await expect(tasks.start({ client: "cli", clientMode: "guard", task: "x", model: "nope" })).rejects.toThrow(/Unknown model/);
  await expect(tasks.start({ client: "cli", clientMode: "guard", task: "x", effort: "huge" })).rejects.toThrow(/Effort/);
});

test("resume continues the same chat with its history; it refuses while running", async () => {
  let release!: () => void;
  const { runner, seen } = echo(new Promise((r) => (release = r)));
  const { runs, tasks } = setup(runner);
  const t = await tasks.start({ client: "cli", clientMode: "guard", task: "First" });
  await expect(tasks.send("cli", t.id, "Second")).rejects.toThrow(/still running/);
  release();
  await runs.idle();
  const next = await tasks.send("cli", t.id, "Second");
  expect(next.turns).toBe(2);
  await runs.idle();
  expect(seen[1]!.task).toContain("Earlier in this chat");
  expect(tasks.get("cli", t.id).answer).toBe("Answer to: Second");
});

test("steer stops the current step and continues with the new message; stop leaves it stopped", async () => {
  const { runner, seen } = echo(new Promise(() => undefined));
  const { runs, tasks } = setup(runner);
  const t = await tasks.start({ client: "cli", clientMode: "guard", task: "Search Bing" });
  await Bun.sleep(5);
  await tasks.steer("cli", t.id, "Use Google instead");
  expect(seen.at(-1)!.task).toContain("Use Google instead");
  expect(tasks.stop("cli", t.id).stopped).toBe(true);
  await runs.idle();
  expect(tasks.get("cli", t.id).status).toBe("stopped");
});

test("queued messages run in order after the current run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: string[] = [];
  const { runs, tasks } = setup(async function* (input) {
    seen.push(input.task.trim().split("\n").at(-1)!);
    if (seen.length === 1) await gate;
    yield { type: "final", text: "ok" };
  });
  const t = await tasks.start({ client: "cli", clientMode: "guard", task: "One" });
  expect((await tasks.queue("cli", t.id, "Two")).queued).toBe(1);
  expect((await tasks.queue("cli", t.id, "Three")).queued).toBe(2);
  release();
  for (let i = 0; i < 50 && seen.length < 3; i++) await Bun.sleep(10);
  await runs.idle();
  expect(seen).toEqual(["One", "Two", "Three"]);
});

test("stop drops queued messages", async () => {
  const seen: string[] = [];
  const { runs, tasks } = setup(async function* (input) {
    seen.push(input.task.trim().split("\n").at(-1)!);
    await new Promise((r) => input.signal.addEventListener("abort", r));
  });
  const t = await tasks.start({ client: "cli", clientMode: "guard", task: "One" });
  await tasks.queue("cli", t.id, "Two");
  expect(tasks.stop("cli", t.id).stopped).toBe(true);
  await runs.idle();
  await Bun.sleep(30);
  await runs.idle();
  expect(seen).toEqual(["One"]);
});

test("delete removes the task's chat", async () => {
  const { runs, tasks } = setup(echo().runner);
  const t = await tasks.start({ client: "cli", clientMode: "guard", task: "One" });
  await runs.idle();
  await tasks.remove("cli", t.id);
  expect(chats.get(t.id)).toBeUndefined();
  expect(tasks.list("cli")).toEqual([]);
});

test("durations and Aside-style exec arguments parse", () => {
  expect(parseDuration("30s")).toBe(30_000);
  expect(parseDuration("5m")).toBe(300_000);
  expect(parseDuration("1h")).toBe(3_600_000);
  expect(parseDuration("45")).toBe(45_000);
  expect(() => parseDuration("soon")).toThrow(/duration/);
  expect(parseExecArgs(["-m", "openai/gpt-6.1-sol", "--effort", "low", "--json", "--timeout", "5m", "Find", "it"])).toEqual({ provider: "codex", model: "gpt-6.1-sol", thinking: "low", task: "Find it" });
  expect(parseExecArgs(["--model", "claude-code/claude-opus-5-5", "Go"])).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5", task: "Go" });
});
