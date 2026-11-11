import { useEffect, useState } from "preact/hooks";
import type { ChatSummary } from "../../api";
import { useAction, useApi } from "../../ui/frame";
import { Icon, Pin, Search, Settings, SquarePen } from "../../ui/icons";

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

/** Pinned chats first, each group newest first. */
export function pinnedFirst(chats: readonly ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
}

const label = (c: ChatSummary) =>
  [c.title, c.pinned && "Pinned", c.status === "running" && "Running", c.status === "waiting" && "Needs your approval", c.unread && "New reply", c.failed && "Failed"].filter(Boolean).join(", ");

/**
 * The chat rail on the new tab page, in the shape of Aside's: a search field, New chat and
 * Settings, then every chat under "Chats", pinned ones first. A blue dot marks a reply not seen
 * yet, a red mark one that failed; hovering a row shows its last message and when.
 * `chats` is null while they load, when the list shows nothing rather than "No chats yet".
 */
export function ChatRail({ chats, now = Date.now() }: { readonly chats: readonly ChatSummary[] | null; readonly now?: number }) {
  const api = useApi();
  const act = useAction();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly ChatSummary[] | null>(null);
  const [tip, setTip] = useState<{ chat: ChatSummary; top: number; left: number } | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let live = true;
    api.searchChats(query).then((r) => live && setResults(r), () => live && setResults([]));
    return () => {
      live = false;
    };
  }, [query]);

  const list = pinnedFirst(results ?? chats ?? []);
  return (
    <nav class="rail" id="chat-rail" aria-label="Chats" onMouseLeave={() => setTip(null)}>
      <label class="rail-search">
        <Icon of={Search} />
        <input
          type="search"
          aria-label="Search chats"
          placeholder="Search.."
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        />
      </label>
      <button type="button" class="row act" onClick={() => act(() => api.newChat())}>
        <Icon of={SquarePen} />New chat
      </button>
      <button type="button" class="row act" onClick={() => act(() => api.openPage("settings"))}>
        <Icon of={Settings} />Settings
      </button>
      <h2 class="rail-lbl" id="rail-chats">{results ? "Results" : "Chats"}</h2>
      <ul class="rail-list" aria-labelledby="rail-chats">
        {list.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              class="row"
              aria-label={label(c)}
              onClick={() => act(() => api.openChat(c.id))}
              onMouseEnter={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setTip({ chat: c, top: r.top, left: r.right + 12 });
              }}
              onMouseLeave={() => setTip(null)}
            >
              <span class="rail-t">{c.title}</span>
              {c.pinned && <Icon of={Pin} size={14} />}
              {c.status !== "idle" ? (
                <span class="rail-mark live" aria-hidden="true" />
              ) : c.failed ? (
                <span class="rail-mark err" aria-hidden="true">!</span>
              ) : c.unread ? (
                <span class="rail-mark new" aria-hidden="true" />
              ) : null}
            </button>
          </li>
        ))}
        {list.length === 0 && (results ?? chats) && <li class="rail-empty">{results ? "No chats match" : "No chats yet"}</li>}
      </ul>
      {tip && (
        <div class="rail-tip" role="tooltip" style={{ top: `${tip.top}px`, left: `${tip.left}px` }}>
          <strong>{tip.chat.title}</strong>
          {tip.chat.snippet && <span class="rail-tip-p">{tip.chat.snippet}</span>}
          <span class="rail-tip-t">{ago(tip.chat.updatedAt, now)}</span>
        </div>
      )}
    </nav>
  );
}
