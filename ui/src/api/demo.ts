/**
 * An in-memory app API with one staged scene, for marketing screenshots of the real pages. Only a
 * `--mode fake` build loads it (boot.tsx); a production build never includes it. No network: every
 * call answers from the state below, and events go straight to the page's listeners.
 */

import { ApiError, type ChatPayload, type Client } from "./client";
import type { AppEvent, AppInfo, ApprovalCard, Chat, ChatMessage, ChatSettings, ChatSummary, RunSnapshot, Step, TabInfo, WindowState } from "./types";

const DEFAULTS: ChatSettings = { mode: "guard", model: "claude-code:claude-opus-5-5", effort: "medium", scope: "current" };

const INFO: AppInfo = {
  models: [
    { id: "codex:gpt-6-astra", label: "GPT-6 Astra", provider: "Codex", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "codex:gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "Codex", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "codex:gpt-6-luna", label: "GPT-6 Luna", provider: "Codex", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-code:claude-fable-5-2", label: "Claude Fable 5.2", provider: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-code:claude-opus-5-5", label: "Claude Opus 5.5", provider: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-code:claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "Claude Code", efforts: ["low", "medium", "high"] },
    { id: "grok:grok-4.7", label: "Grok 4.7", provider: "Grok", efforts: ["low", "medium", "high"] },
  ],
  defaults: DEFAULTS,
  artifactOrigin: "http://127.0.0.1:1",
};

const TAB_ID = "demo-tab";
const CHAT_ID = "demo-chat";
const RUN_ID = "demo-run";
const STEPS: Step[] = [
  { label: "Read the thread on mailroom.app" },
  { label: "Opened calendar.mailroom.app" },
  { label: "Find a free hour on Thursday", detail: "const s = await snapshot(page); log(s.tree.match(/Thu.*free/g))", output: '["Thu 3:00 PM–4:00 PM free"]' },
  { label: 'Added "Planning review" on Thursday, 3:00 to 4:00' },
  { label: 'Typed the reply into textbox "Reply"' },
];
const CARD: ApprovalCard = {
  id: "demo-approval",
  chatId: CHAT_ID,
  runId: RUN_ID,
  title: "Send email to Maya Chen",
  site: "mailroom.app",
  kind: "risky",
  body: "Hi Maya, Thursday works. I've put 3:00 to 4:00 on my calendar for the planning review. See you then. Neel",
  fields: [
    { label: "To", value: "Maya Chen <maya@northwind.co>" },
    { label: "Subject", value: "Re: Thursday planning" },
  ],
  confirm: "Send message",
  danger: false,
};
const STEP_MS = 400;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function seedChats(tab: TabInfo): Chat[] {
  const windowId = tab.windowId;
  const ask: ChatMessage = { id: "demo-m1", role: "user", text: "Maya asked if Thursday works for the planning review. Check my calendar and draft a reply.", time: ago(1), context: tab };
  const main: Chat = { id: CHAT_ID, title: "Reply to Maya about Thursday", createdAt: ago(1), updatedAt: ago(0), settings: DEFAULTS, messages: [ask], tab: { id: TAB_ID, windowId }, draft: "", scrollTop: 0 };
  const past = (id: string, title: string, minutes: number, reply: string): Chat => ({
    id, title, createdAt: ago(minutes), updatedAt: ago(minutes), settings: DEFAULTS, tab: null, draft: "", scrollTop: 0,
    messages: [{ id: `${id}-m1`, role: "user", text: title, time: ago(minutes) }, { id: `${id}-m2`, role: "assistant", text: reply, time: ago(minutes) }],
  });
  return [
    main,
    past("demo-subs", "Subscriptions from receipts", 90, "You pay for 7 subscriptions, $84.17 a month in all."),
    past("demo-fares", "Compare SFO to HND fares", 60 * 26, "The cheapest nonstop is $1,142 round trip on March 12."),
    past("demo-notes", "Summarise Priya's notes", 60 * 50, "Priya's notes cover three decisions and two open questions."),
  ];
}

export function createDemoClient(windowId: string): Client {
  const tab: TabInfo = { id: TAB_ID, windowId, title: "Re: Thursday planning · Mailroom", url: "https://mailroom.app/inbox/t/4821" };
  let chats: readonly Chat[] = seedChats(tab);
  let run: RunSnapshot | null = { runId: RUN_ID, chatId: CHAT_ID, text: "", steps: STEPS, approval: CARD };
  let next = 0;
  const listeners = new Set<(e: AppEvent) => void>();

  const emit = (event: AppEvent) => listeners.forEach((l) => l(event));
  const later = (ms: number, work: () => void) => setTimeout(work, ms);
  const find = (id: string) => {
    const chat = chats.find((c) => c.id === id);
    if (!chat) throw new ApiError("That chat is gone", 404);
    return chat;
  };
  const put = (chat: Chat) => {
    chats = [chat, ...chats.filter((c) => c.id !== chat.id)];
    return chat;
  };
  const summary = (c: Chat): ChatSummary => ({
    id: c.id, title: c.title, updatedAt: c.updatedAt, tab: c.tab, status: run?.chatId === c.id ? (run.approval ? "waiting" : "running") : "idle", preview: c.messages.at(-1)?.text ?? "", ...(c.pinned ? { pinned: true as const } : {}),
  });
  const payload = (chat: Chat | undefined): ChatPayload => ({ chat: chat ?? null, run: chat && run?.chatId === chat.id ? run : null, artifacts: [] });
  const newChat = (over: Partial<Chat> = {}): Chat =>
    put({ id: `demo-new-${++next}`, title: "New chat", createdAt: ago(0), updatedAt: ago(0), settings: DEFAULTS, messages: [], tab: null, draft: "", scrollTop: 0, ...over });
  /** Adds an assistant reply to a chat, ends its run and tells the page. */
  const finish = (chatId: string, runId: string, text: string, steps: Step[]) => {
    const message: ChatMessage = { id: `demo-reply-${++next}`, role: "assistant", text, time: ago(0), ...(steps.length ? { steps } : {}) };
    const chat = put({ ...find(chatId), messages: [...find(chatId).messages, message], updatedAt: ago(0) });
    run = null;
    emit({ type: "run.finished", chatId, runId, message });
    emit({ type: "chat.updated", chat: summary(chat) });
  };
  const ok = <T>(value: T) => Promise.resolve(value);
  const attempt = <T>(work: () => T) => {
    try {
      return ok(work());
    } catch (e) {
      return Promise.reject(e);
    }
  };

  const client: Client = {
    info: () => ok(INFO),
    setDefaults: (patch) => ok({ ...DEFAULTS, ...patch }),
    chats: () => ok(chats.map(summary)),
    createChat: (init = {}) => ok(newChat({ ...(init.title ? { title: init.title } : {}), settings: { ...DEFAULTS, ...init.settings } })),
    chat: (id) => ok(payload(chats.find((c) => c.id === id))),
    patchChat: (id, patch) => attempt(() => {
      const { pinned: wasPinned, ...chat } = find(id);
      const { pinned, read: _read, ...rest } = patch;
      return put({ ...chat, ...rest, ...((pinned ?? wasPinned) ? { pinned: true as const } : {}), settings: { ...chat.settings, ...patch.settings } });
    }),
    deleteChat: (id) => attempt(() => {
      find(id);
      chats = chats.filter((c) => c.id !== id);
      later(0, () => emit({ type: "chat.removed", chatId: id }));
      return { removed: id };
    }),
    send: (id, text, context) => attempt(() => {
      const message: ChatMessage = { id: `demo-ask-${++next}`, role: "user", text, time: ago(0), ...(context ? { context } : {}) };
      put({ ...find(id), messages: [...find(id).messages, message], updatedAt: ago(0) });
      const runId = `demo-run-${next}`;
      run = { runId, chatId: id, text: "", steps: [], approval: null };
      later(0, () => emit({ type: "run.started", chatId: id, runId, message }));
      later(STEP_MS * 2, () => finish(id, runId, "This is a demo of Perch, so it can't act on sites here.", []));
      return { runId, message };
    }),
    // The demo runs one task at a time and queues nothing.
    unqueue: () => ok({ removed: false }),
    sendQueuedNow: () => attempt(() => {
      throw new ApiError("That message is no longer waiting", 404);
    }),
    tabs: () => ok([tab]),
    cancel: (id) => attempt(() => {
      if (run?.chatId !== id) return { stopped: false };
      const { runId, steps } = run;
      later(0, () => finish(id, runId, "Stopped.", steps));
      return { stopped: true };
    }),
    branch: (id, messageId) => attempt(() => {
      const chat = find(id);
      const upto = chat.messages.findIndex((m) => m.id === messageId);
      return newChat({ title: chat.title, settings: chat.settings, messages: chat.messages.slice(0, upto + 1), branchOf: { chatId: id, messageId } });
    }),
    exportChat: (id) => attempt(() => {
      const chat = find(id);
      return [`# ${chat.title}`, ...chat.messages.map((m) => `**${m.role === "user" ? "You" : "Perch"}:** ${m.text}`)].join("\n\n");
    }),
    artifact: () => Promise.reject(new ApiError("This demo has no artifacts", 404)),
    artifactFile: () => Promise.reject(new ApiError("This demo has no artifacts", 404)),
    saveArtifact: () => Promise.reject(new ApiError("This demo can't save artifacts", 400)),
    decide: (approvalId, approved) => attempt(() => {
      const current = run;
      if (!current?.approval || current.approval.id !== approvalId) throw new ApiError("That approval is no longer waiting", 404);
      run = { ...current, approval: null };
      later(0, () => emit({ type: "run.approval.resolved", chatId: current.chatId, runId: current.runId, approvalId, approved }));
      const reply = approved ? "Sent." : "I didn't send it. The reply is still in the draft.";
      const steps = approved ? [...current.steps, { label: 'Clicked button "Send"' }] : current.steps;
      later(STEP_MS, () => finish(current.chatId, current.runId, reply, steps));
      return { ok: true as const };
    }),
    windowState: (id) => {
      const side = chats.find((c) => c.tab?.id === TAB_ID);
      const state: WindowState = { windowId: id, tab: { ...tab, windowId: id }, chatId: side?.id ?? null };
      return ok(state);
    },
    tabChat: (tabId) => ok(payload(chats.find((c) => c.tab?.id === tabId))),
    openSideChat: (tabId, windowId, chatId, settings) => attempt(() => {
      chats = chats.map((c) => (c.tab?.id === tabId ? { ...c, tab: null } : c));
      const at = { id: tabId, windowId };
      return chatId ? put({ ...find(chatId), tab: at }) : newChat({ tab: at, settings: { ...DEFAULTS, ...settings } });
    }),
    connect: (onEvent, onStatus) => {
      listeners.add(onEvent);
      later(0, () => onStatus?.(true));
      return () => void listeners.delete(onEvent);
    },
  };
  return client;
}
