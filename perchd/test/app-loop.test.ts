/** The app API with Perch's real agent loop, a scripted model and headless Chrome for Testing. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { startApp, type App } from "../src/app/app";
import { memoryKeychain } from "../src/app/keychain";
import type { AppEvent, Chat } from "../src/app/protocol";
import { loopRunner } from "../src/app/runner";
import { Vault } from "../src/app/vault";
import { fakeModel } from "../src/models/fake";
import type { Message, TurnEvent, TurnRequest } from "../src/models/types";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
let dir: string;
let app: App;
let n = 0;
const tool = (name: string, args: Record<string, unknown> = {}): TurnEvent[] => [{ type: "tool_call", call: { id: `call_${++n}`, name, args } }, { type: "done" }];
const lastTool = (req: TurnRequest) => [...req.messages].reverse().find((m): m is Extract<Message, { role: "tool" }> => m.role === "tool")!;
const refIn = (req: TurnRequest, label: string) => lastTool(req).content.match(new RegExp(`${label} \\[ref=(e\\d+)\\]`))![1]!;

beforeAll(async () => {
  env = await setup();
  dir = mkdtempSync(join(tmpdir(), "perch-app-loop-"));
  const script = () =>
    fakeModel([
      () => tool("navigate", { url: env.site.url("/mail.html") }),
      (req) => tool("click", { ref: refIn(req, 'button "Compose"') }),
      (req) => tool("type", { ref: refIn(req, 'textbox "To"'), text: "maya@chenstudio.co" }),
      (req) => tool("click", { ref: refIn(req, 'button "Send"') }),
      (req) => tool("done", { answer: lastTool(req).content.includes("Message sent") ? "Sent to Maya." : "Not sent." }),
      // The loop asks for one check before the first done; the answer stands.
      () => tool("done", { answer: "Sent to Maya." }),
    ]);
  app = await startApp({
    dataDir: dir,
    vault: await Vault.open(memoryKeychain(), "Default"),
    runner: loopRunner({ browser: async () => env.browser, model: async (id) => (id === "fake" ? script() : `The model "${id}" is not signed in`), audit: new AuditLog(join(dir, "audit.jsonl")) }),
    models: [{ id: "fake", label: "Scripted", provider: "test", efforts: ["medium"] }],
    allowedOrigins: [],
  });
});
afterAll(async () => {
  await app.stop();
  await env.teardown();
  rmSync(dir, { recursive: true, force: true });
});

const api = (path: string, json?: unknown) =>
  fetch(`${app.server.url}${path}`, { method: json === undefined ? "GET" : "POST", body: json === undefined ? undefined : JSON.stringify(json), headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" } });

test("a Send click waits for approval through the API, then runs and is audited", async () => {
  const events: AppEvent[] = [];
  const ws = new WebSocket(`${app.server.url.replace("http", "ws")}/ws`, ["perch-app", `token.${app.token}`]);
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  await new Promise((r) => (ws.onopen = r));
  const chat = (await (await api("/api/chats", {})).json()) as Chat;
  await api(`/api/chats/${chat.id}/messages`, { text: "Email Maya" });
  const deadline = Date.now() + 20_000;
  let ask: Extract<AppEvent, { type: "run.approval" }> | undefined;
  while (!ask && Date.now() < deadline) {
    ask = events.find((e): e is Extract<AppEvent, { type: "run.approval" }> => e.type === "run.approval");
    await Bun.sleep(20);
  }
  expect(ask!.card).toMatchObject({ confirm: "Send", kind: "risky", site: "127.0.0.1" });
  expect(app.runs.status(chat.id)).toBe("waiting");
  await api(`/api/approvals/${ask!.card.id}`, { approved: true });
  await app.runs.idle();
  const reply = app.chats.get(chat.id)!.messages.at(-1)!;
  expect(reply.text).toBe("Sent to Maya.");
  expect(reply.steps?.map((s) => s.label)).toContain("Opened 127.0.0.1");
  expect(reply.steps?.map((s) => s.label)).toContain('Clicked button "Send"');
  const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(audit.find((e) => e.action === "click" && e.approved === true)).toMatchObject({ detail: expect.stringContaining('button "Send"'), result: "ok", client: "sidebar" });
  ws.close();
}, 30_000);

test("a model that cannot be used ends the run with its reason", async () => {
  const chat = (await (await api("/api/chats", {})).json()) as Chat;
  await app.chats.update(chat.id, (c) => ({ ...c, settings: { ...c.settings, model: "gpt-x" } }));
  await api(`/api/chats/${chat.id}/messages`, { text: "Hi" });
  await app.runs.idle();
  expect(app.chats.get(chat.id)!.messages.at(-1)!.error).toBe('The model "gpt-x" is not signed in');
});
