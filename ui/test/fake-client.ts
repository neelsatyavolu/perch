/** An in-memory stand-in for the app API, for page tests. It records calls and lets tests push events. */

import type { ChatPayload, Client } from "../src/api/client";
import type { AppEvent, AppInfo, Chat, ChatSettings, ChatSummary, TabInfo, WindowState } from "../src/api/types";

export type FakeClient = Client & { calls: { name: string; args: unknown[] }[]; emit(event: AppEvent): void; status(connected: boolean): void; chatsById: Map<string, Chat>; windows: Map<string, WindowState>; marks: Map<string, Partial<ChatSummary>> };

const startInfo: AppInfo = {
  models: [{ id: "fake", label: "Scripted", provider: "Perch", efforts: ["low", "medium", "high"] }],
  defaults: { mode: "guard", model: "fake", effort: "medium", scope: "current" },
  artifactOrigin: "http://127.0.0.1:1",
};

export function fakeClient(): FakeClient {
  const chatsById = new Map<string, Chat>();
  const windows = new Map<string, WindowState>();
  /** List marks a chat carries in the chat list, such as pinned or unread. */
  const marks = new Map<string, Partial<ChatSummary>>();
  const listeners: ((e: AppEvent) => void)[] = [];
  const statusListeners: ((connected: boolean) => void)[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  let n = 0;
  let info = startInfo;
  const record = <T>(name: string, args: unknown[], value: T): Promise<T> => {
    calls.push({ name, args });
    return Promise.resolve(value);
  };
  const newChat = (over: Partial<Chat> = {}): Chat => {
    const chat: Chat = { id: `chat-${++n}`, title: "New chat", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), settings: info.defaults, messages: [], tab: null, draft: "", scrollTop: 0, ...over };
    chatsById.set(chat.id, chat);
    return chat;
  };
  const payload = (chat: Chat | undefined): ChatPayload => ({ chat: chat ?? null, run: null, artifacts: [] });

  const client = {
    calls,
    chatsById,
    windows,
    marks,
    emit: (event: AppEvent) => listeners.forEach((l) => l(event)),
    status: (connected: boolean) => statusListeners.forEach((l) => l(connected)),
    info: () => record("info", [], info),
    setDefaults: (patch: Partial<ChatSettings>) => {
      info = { ...info, defaults: { ...info.defaults, ...patch } };
      listeners.forEach((l) => l({ type: "defaults", defaults: info.defaults }));
      return record("setDefaults", [patch], info.defaults);
    },
    chats: () => record("chats", [], [...chatsById.values()].map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, tab: c.tab, status: "idle" as const, preview: "", ...marks.get(c.id) }))),
    createChat: (init: { settings?: Partial<ChatSettings> } = {}) => record("createChat", [init], newChat({ settings: { ...info.defaults, ...init.settings } })),
    chat: (id: string) => record("chat", [id], payload(chatsById.get(id))),
    patchChat: (id: string, patch: Partial<Chat>) => {
      const next = { ...chatsById.get(id)!, ...patch, settings: { ...chatsById.get(id)!.settings, ...(patch.settings ?? {}) } };
      chatsById.set(id, next);
      return record("patchChat", [id, patch], next);
    },
    deleteChat: (id: string) => record("deleteChat", [id], { removed: id }),
    send: (id: string, text: string, context?: TabInfo, extras?: { files?: string[]; mentions?: string[] }) =>
      record("send", extras ? [id, text, context, extras] : [id, text, context], { runId: "r1", message: { id: `m${++n}`, role: "user" as const, text, time: new Date().toISOString() } }),
    tabs: () => record("tabs", [], [...windows.values()].flatMap((w) => (w.tab ? [w.tab] : []))),
    cancel: (id: string) => record("cancel", [id], { stopped: true }),
    branch: (id: string, messageId: string) => record("branch", [id, messageId], newChat({ title: "Branch" })),
    exportChat: (id: string) => record("exportChat", [id], "# chat"),
    artifact: (id: string) => record("artifact", [id], { meta: { id, chatId: "", title: "", kind: "markdown" as const, version: 1, versions: 1, updatedAt: "", url: "" }, content: "# doc" }),
    artifactFile: (id: string, version?: number) => record("artifactFile", [id, version], new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" })),
    saveArtifact: () => Promise.reject(new Error("not used")),
    decide: (approvalId: string, approved: boolean) => record("decide", [approvalId, approved], { ok: true as const }),
    windowState: (windowId: string) => record("windowState", [windowId], windows.get(windowId) ?? { windowId, tab: null, chatId: null }),
    tabChat: (tabId: string) => record("tabChat", [tabId], payload([...chatsById.values()].find((c) => c.tab?.id === tabId))),
    openSideChat: (tabId: string, windowId: string, chatId?: string) => {
      for (const c of chatsById.values()) if (c.tab?.id === tabId) chatsById.set(c.id, { ...c, tab: null });
      const chat = chatId ? { ...chatsById.get(chatId)!, tab: { id: tabId, windowId } } : newChat({ tab: { id: tabId, windowId } });
      chatsById.set(chat.id, chat);
      return record("openSideChat", [tabId, windowId, chatId], chat);
    },
    connect: (onEvent: (e: AppEvent) => void, onStatus?: (connected: boolean) => void) => {
      listeners.push(onEvent);
      if (onStatus) statusListeners.push(onStatus);
      return () => {
        listeners.splice(listeners.indexOf(onEvent), 1);
        if (onStatus) statusListeners.splice(statusListeners.indexOf(onStatus), 1);
      };
    },
  };
  return client as unknown as FakeClient;
}
