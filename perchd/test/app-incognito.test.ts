import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepEvent } from "../src/agent/loop";
import { startApp, type App } from "../src/app/app";
import { memoryKeychain } from "../src/app/keychain";
import type { Chat } from "../src/app/protocol";
import type { RunnerInput } from "../src/app/runs";
import { Vault } from "../src/app/vault";

const ORIGIN = "chrome://perch-side-chat";
const BROWSER = "b".repeat(43);
let dir: string;
let app: App;
const inputs: RunnerInput[] = [];

async function* runner(input: RunnerInput): AsyncIterable<StepEvent> {
  inputs.push(input);
  yield { type: "final", text: 'Done.\n```artifact html "Card"\n<p>private</p>\n```' };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-incognito-"));
  app = await startApp({
    dataDir: dir,
    vault: await Vault.open(memoryKeychain(), "Default"),
    runner,
    models: [{ id: "fake", label: "Fake", provider: "test", efforts: ["medium"] }],
    allowedOrigins: [ORIGIN],
    browserToken: BROWSER,
  });
});
afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init: { method?: string; json?: unknown; browser?: boolean } = {}) =>
  fetch(`${app.server.url}${path}`, {
    method: init.method ?? "GET",
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    headers: { authorization: `Bearer ${init.browser ? BROWSER : app.token}`, "content-type": "application/json" },
  });

const files = (sub: string) => readdirSync(join(dir, sub)).filter((f) => !f.startsWith("."));

async function settle(chatId: string) {
  await app.runs.idleFor(chatId);
}

test("a side chat in an incognito tab is private: no memory, nothing on disk, gone with the last private window", async () => {
  await call("/api/tabs", { method: "PUT", browser: true, json: { tabs: [
    { id: "normal-1", windowId: "w1", title: "News", url: "https://news.example/" },
    { id: "private-1", windowId: "w2", title: "Shop", url: "https://shop.example/", incognito: true },
    { id: "private-2", windowId: "w2", title: "Bank", url: "https://bank.example/", incognito: true },
  ] } });
  const chat = (await (await call("/api/tabs/private-1/chat", { method: "POST", json: { windowId: "w2" } })).json()) as Chat;
  expect(chat.incognito).toBe(true);
  const before = { chats: files("chats").length, artifacts: files("artifacts").length };
  expect((await call(`/api/chats/${chat.id}/messages`, { method: "POST", json: { text: "compare prices" } })).status).toBe(200);
  await settle(chat.id);
  expect(inputs.at(-1)?.incognito).toBe(true);
  expect(app.artifacts.forChat(chat.id).length).toBe(1);
  expect(files("chats").length).toBe(before.chats);
  expect(files("artifacts").length).toBe(before.artifacts);

  // One private tab closes: the chat stays while another private tab is open.
  await call("/api/tabs/private-1", { method: "DELETE", browser: true });
  expect(app.chats.get(chat.id)).toBeDefined();
  await call("/api/tabs/private-2", { method: "DELETE", browser: true });
  expect(app.chats.get(chat.id)).toBeUndefined();
  expect(app.artifacts.forChat(chat.id).length).toBe(0);
});

test("a normal tab's side chat is saved as before, and a private chat never moves into a normal tab", async () => {
  await call("/api/tabs", { method: "PUT", browser: true, json: { tabs: [
    { id: "normal-1", windowId: "w1", title: "News", url: "https://news.example/" },
    { id: "private-3", windowId: "w3", title: "Mail", url: "https://mail.example/", incognito: true },
  ] } });
  const normal = (await (await call("/api/tabs/normal-1/chat", { method: "POST", json: { windowId: "w1" } })).json()) as Chat;
  expect(normal.incognito).toBeUndefined();
  expect(files("chats")).toContain(`${normal.id}.chat`);
  const priv = (await (await call("/api/tabs/private-3/chat", { method: "POST", json: { windowId: "w3" } })).json()) as Chat;
  expect((await call("/api/tabs/normal-1/chat", { method: "POST", json: { windowId: "w1", chatId: priv.id } })).status).toBe(400);
  expect((await call("/api/tabs/private-3/chat", { method: "POST", json: { windowId: "w3", chatId: normal.id } })).status).toBe(400);
  // The browser's full report without private tabs ends the private chat.
  await call("/api/tabs", { method: "PUT", browser: true, json: { tabs: [{ id: "normal-1", windowId: "w1", title: "News", url: "https://news.example/" }] } });
  expect(app.chats.get(priv.id)).toBeUndefined();
  expect(app.chats.get(normal.id)).toBeDefined();
});

test("a page cannot mark a tab private; only the browser's report does", async () => {
  await call("/api/tabs", { method: "PUT", browser: true, json: { tabs: [{ id: "normal-2", windowId: "w1", title: "A", url: "https://a.example/" }] } });
  const res = await call("/api/tabs/normal-2/chat", { method: "POST", json: { windowId: "w1", incognito: true } });
  expect(res.status).toBe(400);
});
