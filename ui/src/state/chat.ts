/** Pure reducers from app events to what a page shows. Every change returns new objects. */

import type { AppEvent, ArtifactMeta, Chat, ChatSummary, RunSnapshot } from "../api/types";

export type ChatView = { chat: Chat | null; run: RunSnapshot | null; artifacts: ArtifactMeta[] };
export const emptyView: ChatView = Object.freeze({ chat: null, run: null, artifacts: [] });

export function applyToView(view: ChatView, event: AppEvent): ChatView {
  const chat = view.chat;
  // A rename (the chat's generated title, or the user's) reaches the open chat's header too.
  if (event.type === "chat.updated") {
    return chat && event.chat.id === chat.id && event.chat.title !== chat.title ? { ...view, chat: { ...chat, title: event.chat.title } } : view;
  }
  if (!chat || !("chatId" in event) || event.chatId !== chat.id) return view;
  switch (event.type) {
    case "run.started":
      return { ...view, chat: { ...chat, messages: [...chat.messages, event.message] }, run: { runId: event.runId, chatId: chat.id, text: "", steps: [], approval: null } };
    case "run.text":
      return view.run ? { ...view, run: { ...view.run, text: view.run.text + event.delta } } : view;
    case "run.step":
      return view.run ? { ...view, run: { ...view.run, steps: [...view.run.steps, event.label] } } : view;
    case "run.approval":
      // A card with no run of this chat's own: an outside agent or a new client asking (held in perchd).
      return { ...view, run: view.run ? { ...view.run, approval: event.card } : { runId: event.runId, chatId: chat.id, text: "", steps: [], approval: event.card } };
    case "run.approval.resolved":
      if (view.run?.approval?.id !== event.approvalId) return view;
      return { ...view, run: view.run.runId.startsWith("held-") ? null : { ...view.run, approval: null } };
    case "run.finished":
      return { ...view, run: null, chat: { ...chat, messages: [...chat.messages, event.message] } };
    case "artifact.saved":
      return { ...view, artifacts: [...view.artifacts.filter((a) => a.id !== event.artifact.id), event.artifact] };
    default:
      return view;
  }
}

export function applyToList(list: ChatSummary[], event: AppEvent): ChatSummary[] {
  if (event.type === "chat.removed") return list.filter((c) => c.id !== event.chatId);
  if (event.type !== "chat.updated") return list;
  return [...list.filter((c) => c.id !== event.chat.id), event.chat].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
