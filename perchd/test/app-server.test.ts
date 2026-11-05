import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../src/agent/loop";
import type { ApprovalRequest } from "../src/agent/session";
import { startApp, type App } from "../src/app/app";
import { memoryKeychain } from "../src/app/keychain";
import type { AppEvent, Chat } from "../src/app/protocol";
import type { RunnerInput } from "../src/app/runs";
import { Vault } from "../src/app/vault";

const ORIGIN = "chrome://perch-chat";
let dir: string;
let app: App;
const sendReq: ApprovalRequest = { call: { id: "c", name: "type", args: { ref: "e2", text: "On my way", submit: true } }, target: { role: "textbox", name: "Message" }, kind: "risky", site: "chat.example", summary: "" };

async function* runner(input: RunnerInput): AsyncIterable<StepEvent> {
  yield { type: "text", delta: "Drafting. " };
  yield { type: "step", label: "Opened chat.example" };
  if (input.task.includes("needs approval")) {
    const ok = await input.approve(sendReq);
    yield { type: "final", text: ok ? "Sent." : "Not sent." };
    return;
  }
  yield { type: "final", text: 'Done.\n```artifact html "Card"\n<p>hi</p>\n```' };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-app-"));
  app = await startApp({
    dataDir: dir,
    vault: await Vault.open(memoryKeychain(), "Default"),
    runner,
    models: [{ id: "fake", label: "Fake", provider: "test", efforts: ["low", "medium", "high"] }, { id: "other", label: "Other", provider: "test", efforts: ["medium"] }],
    allowedOrigins: [ORIGIN],
  });
});
afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  fetch(`${app.server.url}${path}`, {
    ...init,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
    headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });

function socket(): Promise<{ ws: WebSocket; events: AppEvent[] }> {
  const ws = new WebSocket(`${app.server.url.replace("http", "ws")}/ws`, ["perch-app", `token.${app.token}`]);
  const events: AppEvent[] = [];
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, events });
    ws.onerror = () => reject(new Error("socket refused"));
  });
}

async function until<T>(check: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

test("calls without the token, with a wrong token or a foreign origin are refused", async () => {
  expect((await fetch(`${app.server.url}/api/chats`)).status).toBe(401);
  expect((await api("/api/chats", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await api("/api/chats", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await api("/api/chats", { headers: { host: "evil.example" } })).status).toBe(403);
  const ok = await api("/api/chats", { headers: { origin: ORIGIN } });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
});

test("preflight is answered only for Perch's origins", async () => {
  const good = await fetch(`${app.server.url}/api/chats`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
  expect(good.status).toBe(204);
  expect(good.headers.get("access-control-allow-headers")).toContain("authorization");
  const bad = await fetch(`${app.server.url}/api/chats`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  expect(bad.status).toBe(403);
});

test("the WebSocket needs the token subprotocol", async () => {
  const refused = new WebSocket(`${app.server.url.replace("http", "ws")}/ws`, ["perch-app", "token.wrong"]);
  const closed = await new Promise<boolean>((resolve) => {
    refused.onopen = () => resolve(false);
    refused.onerror = () => resolve(true);
  });
  expect(closed).toBe(true);
  const { ws } = await socket();
  expect(ws.protocol).toBe("perch-app");
  ws.close();
});

test("input is checked at the boundary", async () => {
  expect((await api("/api/chats", { method: "POST", json: { title: 5 } })).status).toBe(400);
  expect((await api("/api/chats", { method: "POST", json: { surprise: true } })).status).toBe(400);
  expect((await api("/api/chats", { method: "POST", json: { settings: { mode: "yolo" } } })).status).toBe(400);
  expect((await api("/api/chats", { method: "POST", json: { settings: { model: "not-listed" } } })).status).toBe(400);
  expect((await api("/api/chats", { method: "POST", body: "{nope" })).status).toBe(400);
  expect((await api("/api/chats", { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
  expect((await api("/api/chats/does-not-exist")).status).toBe(404);
  expect((await api("/api/chats", { method: "PUT" })).status).toBe(405);
});

test("a chat runs end to end: stream, reply, artifact, export", async () => {
  const { ws, events } = await socket();
  const chat = (await (await api("/api/chats", { method: "POST", json: { settings: { model: "other", mode: "ask" } } })).json()) as Chat;
  expect(chat.settings).toMatchObject({ model: "other", mode: "ask", effort: "medium" });
  const sent = await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "Make me a card", context: { id: "t1", windowId: "w1", title: "Home", url: "https://home.example" } } });
  expect(sent.status).toBe(200);
  const finished = await until(() => events.find((e) => e.type === "run.finished"));
  expect(events.some((e) => e.type === "run.text")).toBe(true);
  expect(events.some((e) => e.type === "run.step")).toBe(true);
  const saved = events.find((e): e is Extract<AppEvent, { type: "artifact.saved" }> => e.type === "artifact.saved")!;
  expect(finished.type === "run.finished" && finished.message.text).toContain(`[[artifact:${saved.artifact.id}]]`);
  const view = await (await api(`/api/chats/${chat.id}`)).json();
  expect(view.chat.messages).toHaveLength(2);
  expect(view.artifacts[0].title).toBe("Card");
  const art = await (await api(`/api/artifacts/${saved.artifact.id}`)).json();
  expect(art.content).toBe("<p>hi</p>");
  expect(new URL(art.meta.url).origin).toBe(app.artifactServer.origin);
  expect(new URL(art.meta.url).origin).not.toBe(new URL(app.server.url).origin);
  const exported = await (await api(`/api/chats/${chat.id}/export`)).text();
  expect(exported).toContain("# Make me a card");
  expect(exported).toContain("[Artifact: Card]");
  ws.close();
});

test("an approval goes through the API, and a stale one is refused", async () => {
  const { ws, events } = await socket();
  const chat = (await (await api("/api/chats", { method: "POST", json: {} })).json()) as Chat;
  await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "This needs approval" } });
  const ask = await until(() => events.find((e): e is Extract<AppEvent, { type: "run.approval" }> => e.type === "run.approval"));
  expect(ask.card).toMatchObject({ body: "On my way", confirm: "Type and press Enter" });
  const view = await (await api(`/api/chats/${chat.id}`)).json();
  expect(view.run.approval.id).toBe(ask.card.id);
  expect((await api(`/api/approvals/${ask.card.id}`, { method: "POST", json: { approved: "yes" } })).status).toBe(400);
  expect((await api(`/api/approvals/${ask.card.id}`, { method: "POST", json: { approved: true } })).status).toBe(200);
  expect((await api(`/api/approvals/${ask.card.id}`, { method: "POST", json: { approved: true } })).status).toBe(409);
  await until(() => events.find((e) => e.type === "run.finished"));
  expect(app.chats.get(chat.id)!.messages.at(-1)!.text).toBe("Sent.");
  ws.close();
});

test("side chats follow their tab across switches and windows", async () => {
  const created = (await (await api("/api/tabs/t7/chat", { method: "POST", json: { windowId: "w1" } })).json()) as Chat;
  await api(`/api/chats/${created.id}`, { method: "PATCH", json: { draft: "half-written", scrollTop: 120 } });
  let state = await (await api("/api/windows/w1/active", { method: "POST", json: { tab: { id: "t7", title: "Mail", url: "https://mail.example" } } })).json();
  expect(state.chatId).toBe(created.id);
  state = await (await api("/api/windows/w1/active", { method: "POST", json: { tab: { id: "t8", title: "Docs", url: "https://docs.example" } } })).json();
  expect(state.chatId).toBeNull();
  // The tab is dragged into window w2: its side chat goes with it.
  state = await (await api("/api/windows/w2/active", { method: "POST", json: { tab: { id: "t7", title: "Mail", url: "https://mail.example" } } })).json();
  expect(state.chatId).toBe(created.id);
  const back = await (await api("/api/tabs/t7/chat")).json();
  expect(back.chat).toMatchObject({ draft: "half-written", scrollTop: 120, tab: { id: "t7", windowId: "w2" } });
  expect((await (await api("/api/tabs/t7", { method: "DELETE" })).json()).chat.tab).toBeNull();
  expect((await (await api("/api/tabs/t7/chat")).json()).chat).toBeNull();
});

test("branch and delete", async () => {
  const chat = (await (await api("/api/chats", { method: "POST", json: { title: "Root" } })).json()) as Chat;
  await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "Make me a card" } });
  await app.runs.idle();
  const first = app.chats.get(chat.id)!.messages[0]!;
  const branch = (await (await api(`/api/chats/${chat.id}/branch`, { method: "POST", json: { messageId: first.id } })).json()) as Chat;
  expect(branch.messages).toHaveLength(1);
  expect((await api(`/api/chats/${chat.id}/branch`, { method: "POST", json: { messageId: "missing" } })).status).toBe(404);
  expect((await api(`/api/chats/${chat.id}`, { method: "DELETE" })).status).toBe(200);
  expect(app.chats.get(chat.id)).toBeUndefined();
  expect(app.artifacts.forChat(chat.id)).toEqual([]);
});

test("errors never leak internals", async () => {
  const res = await api("/api/chats/x/messages", { method: "POST", json: { text: "hi" } });
  expect(res.status).toBe(404);
  expect(Object.keys(await res.json())).toEqual(["error"]);
});

test("a Unix socket works and only the owner can open it", async () => {
  const sockDir = mkdtempSync(join(tmpdir(), "perch-sock-"));
  const path = join(sockDir, "app.sock");
  const other = await startApp({ dataDir: join(sockDir, "data"), vault: await Vault.open(memoryKeychain(), "Default"), runner, models: [], allowedOrigins: [], listen: { unix: path } });
  try {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const res = await fetch("http://perch/api/info", { unix: path, headers: { authorization: `Bearer ${other.token}` } } as RequestInit);
    expect(res.status).toBe(200);
    expect((await fetch("http://perch/api/info", { unix: path } as RequestInit)).status).toBe(401);
  } finally {
    await other.stop();
    rmSync(sockDir, { recursive: true, force: true });
  }
});

test("pages hear about renames and removals", async () => {
  const { ws, events } = await socket();
  const chat = (await (await api("/api/chats", { method: "POST", json: {} })).json()) as Chat;
  await api(`/api/chats/${chat.id}`, { method: "PATCH", json: { title: "Trip to Kyoto" } });
  await until(() => events.find((e) => e.type === "chat.updated" && e.chat.title === "Trip to Kyoto"));
  await api(`/api/chats/${chat.id}`, { method: "DELETE" });
  await until(() => events.find((e) => e.type === "chat.removed" && e.chatId === chat.id));
  ws.close();
});
