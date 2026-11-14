/** Pure reducers from app events to what a page shows. Every change returns new objects. */

import type { AppEvent, ArtifactMeta, Chat, ChatSummary, QueuedMessage, RunSnapshot } from "../api/types";

/**
 * A run on screen. `marks[i]`: how long `text` was when step i came, so what the agent said between
 * steps shows in order with them. A step with no mark (a snapshot from perchd has none) counts as 0.
 */
export type RunView = RunSnapshot & { marks?: readonly number[] };

/** `queued`: messages sent while the task ran, waiting to go out as the next turns. */
export type ChatView = { chat: Chat | null; run: RunView | null; artifacts: ArtifactMeta[]; queued: readonly QueuedMessage[] };
export const emptyView: ChatView = Object.freeze({ chat: null, run: null, artifacts: [], queued: [] });

export function applyToView(view: ChatView, event: AppEvent): ChatView {
  const chat = view.chat;
  // A rename (the chat's generated title, or the user's) reaches the open chat's header too.
  if (event.type === "chat.updated") {
    return chat && event.chat.id === chat.id && event.chat.title !== chat.title ? { ...view, chat: { ...chat, title: event.chat.title } } : view;
  }
  if (!chat || !("chatId" in event) || event.chatId !== chat.id) return view;
  switch (event.type) {
    case "run.started":
      // A card already waiting (held for an outside agent) stays when that agent's listed run starts.
      return { ...view, chat: { ...chat, messages: [...chat.messages, event.message] }, run: { runId: event.runId, chatId: chat.id, text: "", steps: [], approval: view.run?.approval ?? null } };
    case "run.text":
      return view.run ? { ...view, run: { ...view.run, text: view.run.text + event.delta } } : view;
    case "run.step":
      if (!view.run) return view;
      return {
        ...view,
        run: {
          ...view.run,
          steps: [...view.run.steps, { label: event.label, ...(event.detail ? { detail: event.detail } : {}) }],
          marks: [...view.run.steps.map((_, i) => view.run!.marks?.[i] ?? 0), view.run.text.length],
        },
      };
    case "run.step.output": {
      const steps = view.run?.steps ?? [];
      const last = steps.at(-1);
      return view.run && last ? { ...view, run: { ...view.run, steps: [...steps.slice(0, -1), { ...last, output: event.output }] } } : view;
    }
    case "run.approval":
      // A card with no run of this chat's own: an outside agent or a new client asking (held in perchd).
      return { ...view, run: view.run ? { ...view.run, approval: event.card } : { runId: event.runId, chatId: chat.id, text: "", steps: [], approval: event.card } };
    case "run.approval.resolved":
      if (view.run?.approval?.id !== event.approvalId) return view;
      return { ...view, run: view.run.runId.startsWith("held-") ? null : { ...view.run, approval: null } };
    case "run.finished":
      return { ...view, run: null, chat: { ...chat, messages: [...chat.messages, event.message] } };
    case "run.queue":
      return { ...view, queued: event.queued };
    case "artifact.removed":
      return { ...view, artifacts: view.artifacts.filter((a) => a.id !== event.artifactId) };
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
