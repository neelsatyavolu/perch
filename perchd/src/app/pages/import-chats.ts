/**
 * Aside's chats as Perch chats. A chat's id is made from Aside's own id, so importing the same
 * chat again lands on the same Perch chat and is skipped. Each turn becomes a user message and,
 * when Aside had an answer, an assistant message. No imported chat belongs to a tab.
 */

import { createHash } from "node:crypto";
import type { Chat as AsideChat } from "../../import/types";
import { DEFAULT_SETTINGS } from "../chats";
import type { Chat, ChatMessage } from "../protocol";

const MAX_TITLE = 200;
const UNTITLED = "Imported chat";

/** A stable UUID-shaped id from a name: the same Aside chat always gets the same Perch id. */
export function stableId(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const asideChatId = (asideId: string) => stableId(`aside-chat:${asideId}`);

const iso = (ms: number) => new Date(ms).toISOString();
const valid = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms < 8.64e15;

/** The Perch chat for an Aside chat, or null when it has no id or nothing was said in it. */
export function chatFromAside(chat: AsideChat, now: number): Chat | null {
  if (typeof chat?.id !== "string" || !chat.id || !Array.isArray(chat.turns)) return null;
  const id = asideChatId(chat.id);
  const created = valid(chat.created) ? chat.created : (chat.turns.map((t) => t.at).find(valid) ?? now);
  const messages = chat.turns.flatMap((turn, i): ChatMessage[] => {
    const time = iso(valid(turn.at) ? turn.at : created);
    const said = (role: ChatMessage["role"], text: unknown): ChatMessage[] =>
      typeof text === "string" && text.trim() ? [{ id: stableId(`${id}:${i}:${role}`), role, text, time }] : [];
    return [...said("user", turn.user), ...said("assistant", turn.assistant)];
  });
  if (messages.length === 0) return null;
  return {
    id,
    title: (typeof chat.title === "string" ? chat.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "") || UNTITLED,
    createdAt: iso(created),
    updatedAt: messages.map((m) => m.time).reduce((a, b) => (a > b ? a : b), iso(created)),
    settings: { ...DEFAULT_SETTINGS },
    messages,
    tab: null,
    draft: "",
    scrollTop: 0,
  };
}
