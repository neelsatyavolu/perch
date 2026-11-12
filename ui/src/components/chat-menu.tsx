/**
 * The side chat's past chats, opened from its title as on Aside: pinned chats under "Pinned", the
 * rest by when they last changed ("Today", "Previous 7 days", "Previous 30 days", then by month).
 * A pin marks pinned rows and an accent dot rows with a reply not yet read.
 */

import type { ChatSummary } from "../api/types";
import { orderChats } from "./chat-list";
import { Icon } from "./icon";
import type { Choice } from "./menu";

const DAY_MS = 86_400_000;

/** The group a chat sits under in the past chats menu, by local calendar day. */
export function chatGroup(chat: Pick<ChatSummary, "updatedAt" | "pinned">, now: number): string {
  if (chat.pinned) return "Pinned";
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const at = new Date(chat.updatedAt);
  const t = at.getTime();
  if (t >= midnight.getTime()) return "Today";
  if (t >= midnight.getTime() - 7 * DAY_MS) return "Previous 7 days";
  if (t >= midnight.getTime() - 30 * DAY_MS) return "Previous 30 days";
  const sameYear = at.getFullYear() === midnight.getFullYear();
  return at.toLocaleDateString(undefined, { month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}

/** The menu's rows: pinned first, then newest first, each under its group. */
export function chatChoices(chats: readonly ChatSummary[], now: number): Choice<string>[] {
  return orderChats(chats).map((c) => ({
    value: c.id,
    label: c.title,
    group: chatGroup(c, now),
    ...(c.tab ? { hint: "In another tab" } : {}),
    mark:
      c.unread || c.pinned ? (
        <>
          {c.unread && <span class="opt-dot" role="img" aria-label="New reply" />}
          {c.pinned && <Icon name="pin" size={12} />}
        </>
      ) : null,
  }));
}
