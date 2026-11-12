import { expect, test } from "bun:test";
import type { ApprovalCard, Chat, ChatMessage, ChatSummary } from "../src/api/types";
import { readConfig } from "../src/api/config";
import { applyToList, applyToView, emptyView, type ChatView } from "../src/state/chat";

const chat: Chat = {
  id: "c1",
  title: "New chat",
  createdAt: "2026-11-05T09:00:00Z",
  updatedAt: "2026-11-05T09:00:00Z",
  settings: { mode: "guard", model: "m", effort: "medium", scope: "current" },
  messages: [],
  tab: null,
  draft: "",
  scrollTop: 0,
};
const user: ChatMessage = { id: "u1", role: "user", text: "Hi", time: "2026-11-05T09:00:01Z" };
const reply: ChatMessage = { id: "a1", role: "assistant", text: "Hello", time: "2026-11-05T09:00:02Z", steps: [{ label: "Opened x" }] };
const card: ApprovalCard = { id: "p1", chatId: "c1", runId: "r1", title: "Click", site: "x", kind: "risky", confirm: "Send", danger: false };

test("a run streams into the view and ends as a saved reply", () => {
  let v: ChatView = { ...emptyView, chat };
  v = applyToView(v, { type: "run.started", chatId: "c1", runId: "r1", message: user });
  expect(v.chat!.messages).toEqual([user]);
  expect(v.run).toEqual({ runId: "r1", chatId: "c1", text: "", steps: [], approval: null });
  const before = v;
  v = applyToView(v, { type: "run.text", chatId: "c1", runId: "r1", delta: "Hel" });
  v = applyToView(v, { type: "run.text", chatId: "c1", runId: "r1", delta: "lo" });
  v = applyToView(v, { type: "run.step", chatId: "c1", runId: "r1", label: "Opened x" });
  expect(before.run!.text).toBe("");
  expect(v.run).toMatchObject({ text: "Hello", steps: [{ label: "Opened x" }] });
  v = applyToView(v, { type: "run.approval", chatId: "c1", runId: "r1", card });
  expect(v.run!.approval).toEqual(card);
  v = applyToView(v, { type: "run.approval.resolved", chatId: "c1", runId: "r1", approvalId: "p1", approved: true });
  expect(v.run!.approval).toBeNull();
  v = applyToView(v, { type: "run.finished", chatId: "c1", runId: "r1", message: reply });
  expect(v.run).toBeNull();
  expect(v.chat!.messages).toEqual([user, reply]);
});

test("events for another chat leave the view alone", () => {
  const v: ChatView = { ...emptyView, chat };
  expect(applyToView(v, { type: "run.text", chatId: "other", runId: "r", delta: "x" })).toBe(v);
  expect(applyToView(v, { type: "artifact.saved", chatId: "other", artifact: { id: "a", chatId: "other", title: "t", kind: "html", version: 1, versions: 1, updatedAt: "", url: "" } })).toBe(v);
});

test("a saved artifact replaces its older version in the view", () => {
  const meta = { id: "a", chatId: "c1", title: "Budget", kind: "markdown" as const, version: 1, versions: 1, updatedAt: "t1", url: "u1" };
  let v: ChatView = { ...emptyView, chat };
  v = applyToView(v, { type: "artifact.saved", chatId: "c1", artifact: meta });
  v = applyToView(v, { type: "artifact.saved", chatId: "c1", artifact: { ...meta, version: 2, versions: 2, url: "u2" } });
  expect(v.artifacts).toHaveLength(1);
  expect(v.artifacts[0]!.version).toBe(2);
});

test("the chat list updates, sorts newest first and drops removed chats", () => {
  const s = (id: string, updatedAt: string): ChatSummary => ({ id, title: id, updatedAt, tab: null, status: "idle", preview: "" });
  let list = [s("a", "2026-11-05T09:00:00Z"), s("b", "2026-11-04T09:00:00Z")];
  list = applyToList(list, { type: "chat.updated", chat: { ...s("b", "2026-11-05T10:00:00Z"), status: "running" } });
  expect(list.map((c) => c.id)).toEqual(["b", "a"]);
  expect(list[0]!.status).toBe("running");
  list = applyToList(list, { type: "chat.updated", chat: s("c", "2026-11-03T09:00:00Z") });
  expect(list.map((c) => c.id)).toEqual(["b", "a", "c"]);
  list = applyToList(list, { type: "chat.removed", chatId: "a" });
  expect(list.map((c) => c.id)).toEqual(["b", "c"]);
});

test("config comes from the host object or the URL fragment, and the token leaves the address bar", () => {
  const replaced: string[] = [];
  const fromHash = readConfig({ href: "http://127.0.0.1:5000/ui/sidebar.html?theme=paper#token=abc&window=w1&tab=t1&accent=teal", replace: (u) => replaced.push(u) });
  expect(fromHash).toMatchObject({ api: "http://127.0.0.1:5000", token: "abc", windowId: "w1", tabId: "t1", theme: "paper", accent: "teal" });
  expect(replaced[0]).toBe("http://127.0.0.1:5000/ui/sidebar.html?theme=paper");
  const fromHost = readConfig({ href: "chrome://perch-chat/", replace: () => {} }, { api: "http://127.0.0.1:9", token: "t", windowId: "w9" });
  expect(fromHost).toMatchObject({ api: "http://127.0.0.1:9", token: "t", windowId: "w9", theme: "ink", accent: "blue" });
  expect(readConfig({ href: "http://127.0.0.1:5000/ui/chat.html", replace: () => {} })).toBeNull();
  expect(readConfig({ href: "http://x/#token=t&theme=neon", replace: () => {} })!.theme).toBe("ink");
});

test("a card held for an outside agent shows in an idle chat and leaves when answered", () => {
  let v: ChatView = { ...emptyView, chat };
  const held = { ...card, runId: "held-1" };
  v = applyToView(v, { type: "run.approval", chatId: "c1", runId: "held-1", card: held });
  expect(v.run).toEqual({ runId: "held-1", chatId: "c1", text: "", steps: [], approval: held });
  v = applyToView(v, { type: "run.approval.resolved", chatId: "c1", runId: "held-1", approvalId: "p1", approved: false });
  expect(v.run).toBeNull();
});
