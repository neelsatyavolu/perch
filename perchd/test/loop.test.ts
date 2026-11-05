import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { runTask, type StepEvent } from "../src/agent/loop";
import { fakeModel } from "../src/models/fake";
import type { Message, TurnEvent, TurnRequest } from "../src/models/types";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
let dir: string;
beforeAll(async () => { env = await setup(); dir = mkdtempSync(join(tmpdir(), "perch-loop-")); });
afterAll(async () => { await env.teardown(); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
const tool = (name: string, args: Record<string, unknown> = {}): TurnEvent[] => [{ type: "tool_call", call: { id: `call_${++n}`, name, args } }, { type: "done" }];
const say = (text: string): TurnEvent[] => [{ type: "text", delta: text }, { type: "done" }];
const lastTool = (req: TurnRequest) => [...req.messages].reverse().find((m): m is Extract<Message, { role: "tool" }> => m.role === "tool")!;
const refIn = (req: TurnRequest, label: string) => {
  const text = lastTool(req).content;
  const match = text.match(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[ref=(e\\d+)\\]`));
  if (!match) throw new Error(`no ${label} in\n${text}`);
  return match[1]!;
};

async function run(script: Parameters<typeof fakeModel>[0], opts: { approve?: boolean; maxSteps?: number } = {}) {
  const model = fakeModel(script);
  const audit = new AuditLog(join(dir, `audit-${++n}.jsonl`));
  const events: StepEvent[] = [];
  for await (const event of runTask({ model, browser: env.browser, task: "Email Maya", mode: "guard", approve: async () => opts.approve ?? false, audit, maxSteps: opts.maxSteps })) {
    events.push(event);
  }
  return { events, model, audit };
}

const sendScript = (afterSend: (req: TurnRequest) => TurnEvent[]) => [
  () => tool("navigate", { url: env.site.url("/mail.html") }),
  (req: TurnRequest) => tool("click", { ref: refIn(req, 'button "Compose"') }),
  (req: TurnRequest) => tool("type", { ref: refIn(req, 'textbox "To"'), text: "maya@chenstudio.co" }),
  (req: TurnRequest) => tool("click", { ref: refIn(req, 'button "Send"') }),
  afterSend,
];

test("Guard mode asks before Send; declining tells the model and nothing is sent", async () => {
  const { events, model, audit } = await run(sendScript((req) => say(lastTool(req).content.includes("declined") ? "Okay, I did not send it." : "Sent.")));
  const approval = events.find((e) => e.type === "approval");
  expect(approval).toMatchObject({ type: "approval", request: { kind: "risky", target: { role: "button", name: "Send" }, site: "127.0.0.1" } });
  expect(events.filter((e) => e.type === "step").map((e) => (e as { label: string }).label)).toEqual([
    "Opened 127.0.0.1",
    'Clicked button "Compose"',
    'Typed into textbox "To"',
  ]);
  expect(lastTool(model.requests.at(-1)!).content).toBe("The user declined this action. Do not try it again; ask or finish.");
  expect(events.at(-1)).toEqual({ type: "final", text: "Okay, I did not send it." });
  const log = readFileSync(audit.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(log.at(-1)).toMatchObject({ action: "click", detail: 'button "Send"', approved: false, result: "declined", client: "sidebar" });
});

test("approving runs the action", async () => {
  const { events, audit } = await run(sendScript((req) => say(lastTool(req).content.includes("Message sent to maya@chenstudio.co") ? "Sent." : "Something went wrong.")), { approve: true });
  expect(events.at(-1)).toEqual({ type: "final", text: "Sent." });
  const log = readFileSync(audit.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(log.at(-1)).toMatchObject({ action: "click", approved: true, result: "ok" });
});

test("a bad tool call is reported back and the loop goes on", async () => {
  const { events, model } = await run([() => tool("click", {}), (req) => say(lastTool(req).content)]);
  expect(model.requests).toHaveLength(2);
  expect(events.at(-1)).toEqual({ type: "final", text: 'missing argument "ref"' });
});

test("the loop stops at maxSteps with a clear message", async () => {
  const { events } = await run(() => tool("snapshot"), { maxSteps: 3 });
  expect(events.at(-1)).toEqual({ type: "error", message: "Stopped after 3 steps without finishing. Ask again with more detail, or raise the step limit." });
});

test("older snapshots are collapsed in what the model sees", async () => {
  const { model } = await run([
    () => tool("navigate", { url: env.site.url("/mail.html") }),
    () => tool("snapshot"),
    () => tool("snapshot"),
    () => say("done"),
  ]);
  const seen = model.requests.at(-1)!.messages.filter((m) => m.role === "tool") as Extract<Message, { role: "tool" }>[];
  expect(seen).toHaveLength(3);
  expect(seen[0]!.content).toMatch(/^\[older page snapshot of http:\/\/127\.0\.0\.1:\d+\/mail\.html, \d+ lines\]$/);
  expect(seen[1]!.content).toMatch(/^\[older page snapshot/);
  expect(seen[2]!.content).toContain('button "Compose"');
});

test("done ends the task with its answer", async () => {
  const { events } = await run([() => tool("done", { answer: "Nothing to do." })]);
  expect(events).toEqual([{ type: "final", text: "Nothing to do." }]);
});

test("a model error ends the task with that message", async () => {
  const { events } = await run([]);
  expect(events.at(-1)).toEqual({ type: "error", message: "the fake model's script ran out" });
});

test("the dev CLI refuses models it cannot sign in to yet", async () => {
  const { main } = await import("../src/cli");
  expect(await main(["run", "--model", "codex", "check mail"])).toBe(2);
  expect(await main(["nope"])).toBe(64);
});

test("the dev CLI runs a task with the fake model", async () => {
  const { main } = await import("../src/cli");
  expect(await main(["run", "--model", "fake", "say hi"])).toBe(0);
});
