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

const inputs: RunnerInput[] = [];

async function* runner(input: RunnerInput): AsyncIterable<StepEvent> {
  inputs.push(input);
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

test("a run gets the nearest effort its model takes, and the chat keeps the one chosen", async () => {
  const { ws, events } = await socket();
  const chat = (await (await api("/api/chats", { method: "POST", json: { settings: { model: "other", effort: "ultra" } } })).json()) as Chat;
  expect(chat.settings.effort).toBe("ultra");
  const before = inputs.length;
  await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "Quick one" } });
  await until(() => events.find((e) => e.type === "run.finished"));
  expect(inputs[before]!.settings.effort).toBe("medium");
  ws.close();
});

test("an approval goes through the API, and a stale one is refused", async () => {
  const { ws, events } = await socket();
  const chat = (await (await api("/api/chats", { method: "POST", json: {} })).json()) as Chat;
  await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "This needs approval" } });
  const ask = await until(() => events.find((e): e is Extract<AppEvent, { type: "run.approval" }> => e.type === "run.approval"));
  expect(ask.card).toMatchObject({ body: "On my way", confirm: "Send message" });
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

test("a tab switch reaches every page as window.active, and closing the active tab clears it", async () => {
  const { ws, events } = await socket();
  const side = (await (await api("/api/tabs/t20/chat", { method: "POST", json: { windowId: "w5" } })).json()) as Chat;
  await api("/api/windows/w5/active", { method: "POST", json: { tab: { id: "t20", title: "Mail", url: "https://mail.example" } } });
  const shown = await until(() => events.find((e) => e.type === "window.active" && e.state.windowId === "w5" && e.state.tab?.id === "t20"));
  expect(shown.type === "window.active" && shown.state.chatId).toBe(side.id);
  await api("/api/tabs/t20", { method: "DELETE" });
  await until(() => events.find((e) => e.type === "window.active" && e.state.windowId === "w5" && e.state.tab === null));
  ws.close();
});

test("deleting a chat does not wait for another chat's run", async () => {
  const { ws, events } = await socket();
  const waiting = (await (await api("/api/chats", { method: "POST", json: {} })).json()) as Chat;
  const doomed = (await (await api("/api/chats", { method: "POST", json: {} })).json()) as Chat;
  await api(`/api/chats/${waiting.id}/messages`, { method: "POST", json: { text: "This needs approval" } });
  const ask = await until(() => events.find((e): e is Extract<AppEvent, { type: "run.approval" }> => e.type === "run.approval" && e.chatId === waiting.id));
  const outcome = await Promise.race([api(`/api/chats/${doomed.id}`, { method: "DELETE" }).then((r) => r.status), Bun.sleep(1000).then(() => "hung")]);
  expect(outcome).toBe(200);
  expect(app.runs.status(waiting.id)).toBe("waiting");
  await api(`/api/approvals/${ask.card.id}`, { method: "POST", json: { approved: false } });
  await app.runs.idle();
  ws.close();
});

test("a branch keeps its artifacts after the source chat is deleted", async () => {
  const chat = (await (await api("/api/chats", { method: "POST", json: {} })).json()) as Chat;
  await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "Make me a card" } });
  await app.runs.idle();
  const reply = app.chats.get(chat.id)!.messages[1]!;
  const branch = (await (await api(`/api/chats/${chat.id}/branch`, { method: "POST", json: { messageId: reply.id } })).json()) as Chat;
  const copied = branch.messages[1]!.artifacts![0]!;
  expect(copied).not.toBe(reply.artifacts![0]);
  expect(branch.messages[1]!.text).toContain(`[[artifact:${copied}]]`);
  expect((await api(`/api/chats/${chat.id}`, { method: "DELETE" })).status).toBe(200);
  const view = await (await api(`/api/chats/${branch.id}`)).json();
  expect(view.artifacts.map((a: { id: string; title: string }) => [a.id, a.title])).toEqual([[copied, "Card"]]);
  expect((await (await api(`/api/artifacts/${copied}`)).json()).content).toBe("<p>hi</p>");
});

test("an image artifact downloads through the API as an attachment", async () => {
  const chat = (await (await api("/api/chats", { method: "POST", json: {} })).json()) as Chat;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const meta = await (await api(`/api/chats/${chat.id}/artifacts`, { method: "POST", json: { title: "Chart", kind: "image", mime: "image/png", content: png.toString("base64") } })).json();
  const res = await api(`/api/artifacts/${meta.id}/file?version=1`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="Chart.png"');
  expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
  expect((await api(`/api/artifacts/${meta.id}/file?version=9`)).status).toBe(404);
  expect((await fetch(`${app.server.url}/api/artifacts/${meta.id}/file`)).status).toBe(401);
});

test("the browser's open-tab list replaces the known tabs and frees side chats of tabs it does not have", async () => {
  const kept = (await (await api("/api/tabs/t30/chat", { method: "POST", json: { windowId: "w6" } })).json()) as Chat;
  const stale = (await (await api("/api/tabs/t31/chat", { method: "POST", json: { windowId: "w6" } })).json()) as Chat;
  const tabs = [
    { id: "t30", windowId: "w6", title: "Mail", url: "https://mail.example" },
    { id: "t32", windowId: "w7", title: "Docs", url: "https://docs.example" },
  ];
  const res = await (await api("/api/tabs", { method: "PUT", json: { tabs } })).json();
  expect(res.released).toEqual([stale.id]);
  expect(app.chats.get(stale.id)!.tab).toBeNull();
  expect(app.chats.get(kept.id)!.tab).toEqual({ id: "t30", windowId: "w6" });
  expect(app.windows.tabs()).toEqual(tabs);
  expect((await api("/api/tabs", { method: "PUT", json: { tabs: [{ id: "bad id!" }] } })).status).toBe(400);
});

test("a navigation updates the tab, and the window showing it hears about it", async () => {
  const { ws, events } = await socket();
  await api("/api/windows/w8/active", { method: "POST", json: { tab: { id: "t40", title: "Inbox", url: "https://mail.example" } } });
  const res = await api("/api/tabs/t40", { method: "PATCH", json: { windowId: "w8", title: "Re: Lunch", url: "https://mail.example/m/1" } });
  expect(res.status).toBe(200);
  await until(() => events.find((e) => e.type === "window.active" && e.state.tab?.title === "Re: Lunch"));
  expect(app.windows.tab("t40")).toEqual({ id: "t40", windowId: "w8", title: "Re: Lunch", url: "https://mail.example/m/1" });
  expect(app.windows.state("w8").tab?.url).toBe("https://mail.example/m/1");
  ws.close();
});

test("a side chat task works in the user's tab, by the target the browser reported", async () => {
  // What the browser's tab sync sends (overlay/chrome/browser/perch/side_panel/perch_tab_sync.cc).
  await api("/api/windows/w9/active", { method: "POST", json: { tab: { id: "t50", title: "Shop", url: "https://shop.example", targetId: "A1B2C3" } } });
  expect((await api("/api/tabs/t50", { method: "PATCH", json: { windowId: "w9", title: "Cart", url: "https://shop.example/cart", targetId: "A1B2C3" } })).status).toBe(200);
  expect(app.windows.tab("t50")?.targetId).toBe("A1B2C3");
  const chat = (await (await api("/api/tabs/t50/chat", { method: "POST", json: { windowId: "w9" } })).json()) as Chat;
  const before = inputs.length;
  // A page that names another target is ignored: the target comes from the browser.
  const context = { id: "t50", windowId: "w9", title: "Cart", url: "https://shop.example/cart", targetId: "EVIL" };
  const sent = await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "What is in my cart?", context } });
  expect(sent.status).toBe(200);
  await until(() => inputs.length > before);
  const input = inputs[inputs.length - 1]!;
  expect(input.tab?.targetId).toBe("A1B2C3");
  expect(input.task).toContain("you are already in it");
  const stored = (await (await api(`/api/chats/${chat.id}`)).json()) as { chat: Chat } | Chat;
  const messages = ("chat" in stored ? stored.chat : stored).messages;
  expect(messages.at(-1)?.context).toEqual({ id: "t50", windowId: "w9", title: "Cart", url: "https://shop.example/cart" });
});

test("a tab the browser never reported gets no target, and the task opens it instead", async () => {
  const chat = (await (await api("/api/tabs/t51/chat", { method: "POST", json: { windowId: "w9" } })).json()) as Chat;
  const before = inputs.length;
  await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "Summarize", context: { id: "t51", windowId: "w9", title: "Blog", url: "https://blog.example", targetId: "EVIL" } } });
  await until(() => inputs.length > before);
  const input = inputs[inputs.length - 1]!;
  expect(input.tab).toBeUndefined();
  expect(input.task).toContain("which you may open and use");
});

test("a finished reply is unread until the chat is read, and pinning or reading keeps its place", async () => {
  const { ws, events } = await socket();
  const chat = (await (await api("/api/chats", { method: "POST", json: {} })).json()) as Chat;
  await api(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "Unread check" } });
  await until(() => events.find((e) => e.type === "run.finished" && e.chatId === chat.id));
  type Row = { id: string; updatedAt: string; unread?: true; pinned?: true; failed?: true };
  const row = async () => ((await (await api("/api/chats")).json()) as Row[]).find((c) => c.id === chat.id)!;
  const before = await row();
  expect(before.unread).toBe(true);
  expect(before.failed).toBeUndefined();
  expect((await api(`/api/chats/${chat.id}`, { method: "PATCH", json: { read: true, pinned: true } })).status).toBe(200);
  const after = await row();
  expect(after.unread).toBeUndefined();
  expect(after.pinned).toBe(true);
  expect(after.updatedAt).toBe(before.updatedAt);
  await api(`/api/chats/${chat.id}`, { method: "PATCH", json: { pinned: false } });
  expect((await row()).pinned).toBeUndefined();
  expect((await api(`/api/chats/${chat.id}`, { method: "PATCH", json: { read: false } })).status).toBe(400);
  ws.close();
});
