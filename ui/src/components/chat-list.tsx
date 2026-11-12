/**
 * The chat list beside the full-page chat, in the shape of Aside's: a search field, New chat and
 * Settings, then every chat under "Chats", pinned ones first. A word at a row's end says its state
 * (Working, Waiting, Failed or New); hovering a row shows its last message and when.
 */

import { useState } from "preact/hooks";
import type { ChatSummary } from "../api/types";
import { Icon } from "./icon";

const STATUS_WORDS = { idle: "", running: "Running", waiting: "Needs your approval" } as const;
const ROW_WORDS = { idle: "", running: "Working", waiting: "Waiting" } as const;

type Props = {
  chats: ChatSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Opens Perch's settings; the row is left out without it. */
  onSettings?: () => void;
  now?: number;
};

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", then the date. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return n(Math.floor(s / 60), "minute");
  if (s < 86_400) return n(Math.floor(s / 3600), "hour");
  if (s < 7 * 86_400) return n(Math.floor(s / 86_400), "day");
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Pinned chats first, each group newest first; `query` keeps chats whose title or last message has it. */
export function orderChats(chats: readonly ChatSummary[], query = ""): ChatSummary[] {
  const q = query.trim().toLowerCase();
  const shown = q ? chats.filter((c) => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)) : [...chats];
  return shown.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
}

export function ChatList({ chats, selected, onSelect, onNew, onSettings, now = Date.now() }: Props) {
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<{ chat: ChatSummary; top: number; left: number } | null>(null);
  const shown = orderChats(chats, query);
  return (
    <nav class="chats" aria-label="Chats" onMouseLeave={() => setHover(null)}>
      <label class="chats-search">
        <Icon name="search" />
        <input type="search" placeholder="Search chats" aria-label="Search chats" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <button type="button" class="row act" onClick={onNew}>
        <Icon name="pen" />
        New chat
      </button>
      {onSettings && (
        <button type="button" class="row act" onClick={onSettings}>
          <Icon name="settings" />
          Settings
        </button>
      )}
      <span class="lbl">Chats</span>
      {shown.length === 0 && <p class="empty-note">{query.trim() ? "No chats match" : "No chats yet"}</p>}
      {shown.map((c) => (
        <button
          type="button"
          key={c.id}
          class={c.id === selected ? "row sel" : "row"}
          aria-current={c.id === selected ? "page" : undefined}
          aria-label={[c.title, c.pinned && "Pinned", STATUS_WORDS[c.status], c.unread && "New reply", c.failed && "Failed"].filter(Boolean).join(", ")}
          onClick={() => onSelect(c.id)}
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover({ chat: c, top: r.top, left: r.right + 12 });
          }}
          onMouseLeave={() => setHover(null)}
        >
          <span class="row-t">{c.title}</span>
          {c.pinned && <Icon name="pin" />}
          {c.status !== "idle" ? (
            <span class="row-s" aria-hidden="true">
              {ROW_WORDS[c.status]}
            </span>
          ) : c.failed ? (
            <span class="row-s err" aria-hidden="true">
              Failed
            </span>
          ) : c.unread ? (
            <span class="row-s" aria-hidden="true">
              New
            </span>
          ) : null}
        </button>
      ))}
      {hover && (
        <div class="chat-tip" role="tooltip" style={{ top: `${hover.top}px`, left: `${hover.left}px` }}>
          <strong>{hover.chat.title}</strong>
          {hover.chat.preview && <span class="tip-p">{hover.chat.preview}</span>}
          <span class="tip-t">{ago(hover.chat.updatedAt, now)}</span>
        </div>
      )}
    </nav>
  );
}
