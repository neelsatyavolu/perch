/**
 * The right sidebar chat (spec 5.3, 7.6). Each tab has its own side chat: when the browser
 * switches tabs, this page saves the unsent draft and scroll position, then shows the new tab's
 * side chat or the empty state. Switching back restores both. Tasks keep running meanwhile. A draft
 * typed in a tab that has no side chat yet is kept here, per tab, until the tab gets one.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ChatPayload, Client } from "../api/client";
import type { AppInfo, ArtifactMeta, ChatSettings, ChatSummary, TabInfo } from "../api/types";
import { Composer } from "../components/composer";
import { Icon, PerchDot } from "../components/icon";
import { Menu } from "../components/menu";
import { Thread } from "../components/thread";
import { applyToList } from "../state/chat";
import { useChat } from "../state/use-chat";
import type { PageHost } from "../host/frame-host";

/** What the browser offers the sidebar page; absent in development. */
export type SidebarHost = PageHost;

type Props = { client: Client; windowId: string; fallbackTab?: TabInfo | null; host?: SidebarHost };

const SCROLL_SAVE_MS = 500;
export const SIDEBAR_EMPTY = "Ask Perch about this page, or give it a task on any site you are signed in to.";

/** The header's status words; in a narrow side chat only the dot shows, with these as its tooltip. */
const STATE_WORDS = { idle: "", running: "Working", waiting: "Waiting for you" } as const;

export function Sidebar({ client, windowId, fallbackTab = null, host }: Props) {
  const chat = useChat(client);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [recent, setRecent] = useState<ChatSummary[]>([]);
  const [pending, setPending] = useState<Partial<ChatSettings>>({});
  /** False until the first tab's chat is known, so the empty state never flashes before it. */
  const [loaded, setLoaded] = useState(false);
  const tabRef = useRef<string | null>(null);
  /** Unsent drafts of tabs that have no side chat yet. */
  const unbound = useRef(new Map<string, string>());
  const scroll = useRef<{ chatId: string | null; top: number; saved: number; timer?: ReturnType<typeof setTimeout> }>({ chatId: null, top: 0, saved: 0 });
  const { view } = chat;

  const saveScroll = async () => {
    const s = scroll.current;
    clearTimeout(s.timer);
    if (s.chatId && s.top !== s.saved) {
      s.saved = s.top;
      await client.patchChat(s.chatId, { scrollTop: s.top }).catch(() => undefined);
    }
  };

  const keepUnboundDraft = () => {
    const { chatId, draft } = chat.unsent();
    const tabId = tabRef.current;
    if (!tabId || chatId) return;
    if (draft) unbound.current.set(tabId, draft);
    else unbound.current.delete(tabId);
  };

  /** Shows `next` with its chat in one update: the tab chip, header and thread change together. */
  const present = (next: TabInfo | null, payload: ChatPayload | null) => {
    setTab(next);
    scroll.current = { chatId: payload?.chat?.id ?? null, top: payload?.chat?.scrollTop ?? 0, saved: payload?.chat?.scrollTop ?? 0 };
    chat.show(payload, next ? unbound.current.get(next.id) ?? "" : "");
    setLoaded(true);
  };

  /**
   * Switches to a tab. `chatId` is the tab's side chat when the browser already said (null: none,
   * so nothing to fetch); undefined asks perchd. The outgoing scroll and draft save in the background.
   */
  const showTab = async (next: TabInfo | null, chatId?: string | null) => {
    keepUnboundDraft();
    const id = next?.id ?? null;
    tabRef.current = id;
    void saveScroll();
    const payload = next && chatId !== null ? await client.tabChat(next.id).catch(() => null) : null;
    if (tabRef.current !== id) return;
    present(next, payload);
  };

  /** After the event stream comes back: events sent while it was down are lost, so reload what is shown. */
  const resync = async () => {
    void client.chats().then(setRecent).catch(() => undefined);
    const s = await client.windowState(windowId).catch(() => null);
    if (!s) return;
    if ((s.tab?.id ?? null) !== tabRef.current) return void showTab(s.tab, s.chatId);
    const payload = s.tab ? await client.tabChat(s.tab.id).catch(() => null) : null;
    if (tabRef.current !== (s.tab?.id ?? null)) return;
    if ((payload?.chat?.id ?? null) !== chat.unsent().chatId) return present(s.tab, payload);
    // The same chat: refresh it and keep what is being typed.
    setTab(s.tab);
    if (payload?.chat) chat.setView({ chat: payload.chat, run: payload.run, artifacts: payload.artifacts });
  };

  useEffect(() => {
    void client.info().then(setInfo).catch((e: Error) => chat.setError(e.message));
    void client.chats().then(setRecent).catch(() => undefined);
    void client
      .windowState(windowId)
      .then((s) => showTab(s.tab ?? fallbackTab, s.tab ? s.chatId : undefined))
      .catch(() => showTab(fallbackTab));
    let dropped = false;
    const close = client.connect(
      (event) => {
        setRecent((l) => applyToList(l, event));
        chat.onEvent(event);
        if (event.type === "chat.removed" && scroll.current.chatId === event.chatId) {
          clearTimeout(scroll.current.timer);
          scroll.current = { chatId: null, top: 0, saved: 0 };
        }
        if (event.type !== "window.active" || event.state.windowId !== windowId) return;
        // The same tab again means its title or address changed: keep the chat, refresh the context.
        if (event.state.tab?.id !== tabRef.current) void showTab(event.state.tab, event.state.chatId);
        else if (event.state.tab) setTab(event.state.tab);
      },
      (connected) => {
        if (!connected) dropped = true;
        else if (dropped) {
          dropped = false;
          void resync();
        }
      },
    );
    return () => {
      close();
      void saveScroll();
    };
  }, [client, windowId]);

  const attach = async (chatId?: string) => {
    if (!tab) return chatId ?? (await client.createChat({ settings: pending })).id;
    const side = await client.openSideChat(tab.id, windowId, chatId, chatId ? undefined : pending);
    unbound.current.delete(tab.id);
    setPending({});
    scroll.current = { chatId: side.id, top: side.scrollTop, saved: side.scrollTop };
    chat.show(chatId ? await client.chat(side.id) : { chat: side, run: null, artifacts: [] });
    return side.id;
  };

  const openArtifact = useCallback((meta: ArtifactMeta) => (host?.openTab ? host.openTab(meta.url) : void window.open(meta.url, "_blank", "noopener,noreferrer")), [host]);

  const status = view.run ? (view.run.approval ? "waiting" : "running") : "idle";
  const settings: ChatSettings = view.chat?.settings ?? { ...(info?.defaults ?? { mode: "guard", model: "", effort: "medium", scope: "current" }), ...pending };
  const others = recent.filter((c) => c.id !== view.chat?.id).slice(0, 12);

  return (
    <aside class="side" aria-label="Perch" data-ready={info ? "true" : undefined}>
      {/* The panel's only header: the browser draws none above it, so close lives here too. */}
      <header class="side-h">
        <h1 class="title">{loaded ? view.chat?.title ?? "New chat" : ""}</h1>
        <PerchDot status={status} title={STATE_WORDS[status]} />
        {status !== "idle" && <span class="state">{STATE_WORDS[status]}</span>}
        <Menu label="Recent chats" align="end" choices={others.map((c) => ({ value: c.id, label: c.title, hint: c.tab ? "In another tab" : undefined }))} selected={[]} empty="No other chats yet" onPick={(c) => void chat.run(() => attach(c.value))}>
          <Icon name="history" />
        </Menu>
        <button type="button" class="ib" aria-label="New chat" title="New chat" disabled={!view.chat} onClick={() => void chat.run(() => attach())}>
          <Icon name="pen" />
        </button>
        {view.chat && host?.openFullChat && (
          <button type="button" class="ib" aria-label="Open in full view" title="Open in full view" onClick={() => view.chat && host.openFullChat?.(view.chat.id)}>
            <Icon name="expand" />
          </button>
        )}
        <button type="button" class="ib" aria-label="Close side chat" title="Close side chat" onClick={() => host?.close?.()}>
          <Icon name="x" />
        </button>
      </header>
      <Thread
        view={view}
        error={chat.error}
        empty={loaded ? SIDEBAR_EMPTY : ""}
        onDecide={chat.decide}
        onOpenArtifact={openArtifact}
        onScroll={(top) => {
          const s = scroll.current;
          s.top = top;
          clearTimeout(s.timer);
          s.timer = setTimeout(() => void saveScroll(), SCROLL_SAVE_MS);
        }}
      />
      {/* One composer per tab: its files, @ picks and dictation never carry over to another tab. */}
      <Composer
        key={tab?.id ?? "none"}
        draft={chat.draft}
        onDraft={chat.setDraft}
        onSend={(text, extras) => chat.send(text, tab ?? undefined, () => attach(), extras)}
        host={host}
        listTabs={() => client.tabs()}
        frame={chat.frame}
        onStop={() => void chat.stop()}
        running={Boolean(view.run)}
        tab={tab}
        settings={settings}
        models={info?.models ?? []}
        onSettings={(patch) => void chat.setSettings(patch, (p) => setPending((s) => ({ ...s, ...p })))}
        autoFocus
      />
    </aside>
  );
}
