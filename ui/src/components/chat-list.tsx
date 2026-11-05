/** The chat list on the full-page chat: grouped by day, the selected row marked with the accent. */

import { Fragment } from "preact";
import type { ChatSummary } from "../api/types";
import { Icon, PerchDot } from "./icon";

const DAY = 86_400_000;

function group(iso: string, now: number): string {
  const d = new Date(iso);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (d.getTime() >= start.getTime()) return "Today";
  if (d.getTime() >= start.getTime() - 6 * DAY) return "This week";
  return "Earlier";
}

const STATUS_WORDS = { idle: "", running: "Running", waiting: "Needs your approval" } as const;

type Props = { chats: ChatSummary[]; selected: string | null; onSelect: (id: string) => void; onNew: () => void; now?: number };

export function ChatList({ chats, selected, onSelect, onNew, now = Date.now() }: Props) {
  let last = "";
  return (
    <nav class="chats" aria-label="Chats">
      <button type="button" class="row act" onClick={onNew}>
        <Icon name="pen" />
        New chat
      </button>
      {chats.length === 0 && <p class="lbl">No chats yet</p>}
      {chats.map((c) => {
        const g = group(c.updatedAt, now);
        const heading = g !== last ? <span class="lbl">{g}</span> : null;
        last = g;
        return (
          <Fragment key={c.id}>
            {heading}
            <button
              type="button"
              class={c.id === selected ? "row sel" : "row"}
              aria-current={c.id === selected ? "page" : undefined}
              title={STATUS_WORDS[c.status] ? `${c.title} · ${STATUS_WORDS[c.status]}` : c.title}
              onClick={() => onSelect(c.id)}
            >
              <span class="row-t">{c.title}</span>
              <PerchDot status={c.status} />
              {c.status !== "idle" && <span class="sr">{STATUS_WORDS[c.status]}</span>}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
