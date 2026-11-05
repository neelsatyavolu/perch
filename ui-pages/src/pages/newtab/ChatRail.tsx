import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatSummary } from "../../api";
import { useAction, useApi } from "../../ui/frame";
import { Icon, Search, SquarePen } from "../../ui/icons";

/** The 200px chat rail on the new tab page: New chat, Search chats, then recent chats (as in Aside). */
export function ChatRail({ chats }: { readonly chats: readonly ChatSummary[] }) {
  const api = useApi();
  const act = useAction();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly ChatSummary[] | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searching) field.current?.focus();
  }, [searching]);

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

  const list = results ?? chats;
  return (
    <nav class="rail" id="chat-rail" aria-label="Chats">
      <button type="button" class="row act" onClick={() => act(() => api.newChat())}>
        <Icon of={SquarePen} />New chat
      </button>
      {searching ? (
        <input
          ref={field}
          type="search"
          class="field rail-search"
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              setSearching(false);
            }
          }}
        />
      ) : (
        <button type="button" class="row act" onClick={() => setSearching(true)}>
          <Icon of={Search} />Search chats
        </button>
      )}
      <h2 class="rail-lbl" id="rail-recent">{results ? "Results" : "Recent"}</h2>
      <ul class="rail-list" aria-labelledby="rail-recent">
        {list.map((c) => (
          <li key={c.id}>
            <button type="button" class="row" title={c.title} onClick={() => act(() => api.openChat(c.id))}>
              {c.title}
            </button>
          </li>
        ))}
        {list.length === 0 && <li class="rail-empty">{results ? "No chats match" : "No chats yet"}</li>}
      </ul>
    </nav>
  );
}
