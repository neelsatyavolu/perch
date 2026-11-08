/**
 * Heartbeat routines (spec 8): on its schedule a routine wakes one of the person's chats, sends
 * its task there as a new message, and waits for the answer. The chat keeps its own model, mode
 * and approval cards, so whoever looks at the chat answers them.
 */

import type { WakeResult } from "../routines/runner";
import type { ChatStore } from "./chats";
import type { RunManager } from "./runs";

export async function wakeChat(app: { chats: ChatStore; runs: RunManager }, chatId: string, task: string, signal?: AbortSignal): Promise<WakeResult> {
  const chat = app.chats.get(chatId);
  if (!chat) return { status: "error", answer: "The chat this routine wakes was deleted." };
  if (chat.incognito) return { status: "error", answer: "A routine can't wake a private chat." };
  if (app.runs.status(chatId) !== "idle") return { status: "skipped", answer: "The chat was busy with another task, so this run was skipped." };
  const stop = () => app.runs.cancel(chatId);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) return { status: "cancelled", answer: "The run was stopped." };
    await app.runs.send(chatId, task);
    await app.runs.idleFor(chatId);
    const reply = app.chats.get(chatId)?.messages.findLast((m) => m.role === "assistant");
    if (!reply) return { status: "error", answer: "The chat gave no answer." };
    if (reply.stopped) return { status: "cancelled", answer: "The run was stopped." };
    if (reply.error) return { status: "error", answer: reply.error };
    return { status: "ok", answer: reply.text };
  } catch (error) {
    return { status: "error", answer: error instanceof Error ? error.message : String(error) };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
