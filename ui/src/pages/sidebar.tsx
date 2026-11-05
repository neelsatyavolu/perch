/**
 * The right sidebar chat (spec 5.3, 7.6). Each tab has its own side chat: when the browser
 * switches tabs, this page saves the unsent draft and scroll position, then shows the new tab's
 * side chat or the empty state. Switching back restores both. Tasks keep running meanwhile.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { Client } from "../api/client";
import type { AppInfo, ChatSettings, ChatSummary, TabInfo } from "../api/types";
import { Composer } from "../components/composer";
import { Icon, PerchDot } from "../components/icon";
import { Menu } from "../components/menu";
import { Thread } from "../components/thread";
import { applyToList } from "../state/chat";
import { useChat } from "../state/use-chat";

/** What the browser offers the sidebar page; absent in development. */
export type SidebarHost = { close?: () => void; openTab?: (url: string) => void };

type Props = { client: Client; windowId: string; fallbackTab?: TabInfo | null; host?: SidebarHost };

const SCROLL_SAVE_MS = 500;
export const SIDEBAR_EMPTY = "Ask Perch about this page, or give it a task on any site you are signed in to.";

export function Sidebar({ client, windowId, fallbackTab = null, host }: Props) {
  const chat = useChat(client);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [recent, setRecent] = useState<ChatSummary[]>([]);
  const [pending, setPending] = useState<Partial<ChatSettings>>({});
  const tabRef = useRef<string | null>(null);
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

  const showTab = async (next: TabInfo | null) => {
    tabRef.current = next?.id ?? null;
    await saveScroll();
    setTab(next);
    const payload = next ? await client.tabChat(next.id).catch(() => null) : null;
    if (tabRef.current !== (next?.id ?? null)) return;
    scroll.current = { chatId: payload?.chat?.id ?? null, top: payload?.chat?.scrollTop ?? 0, saved: payload?.chat?.scrollTop ?? 0 };
    await chat.show(payload);
  };

  useEffect(() => {
    void client.info().then(setInfo).catch((e: Error) => chat.setError(e.message));
    void client.chats().then(setRecent).catch(() => undefined);
    void client
      .windowState(windowId)
      .then((s) => showTab(s.tab ?? fallbackTab))
      .catch(() => showTab(fallbackTab));
    const close = client.connect((event) => {
      setRecent((l) => applyToList(l, event));
      chat.onEvent(event);
      if (event.type === "window.active" && event.state.windowId === windowId && event.state.tab?.id !== tabRef.current) void showTab(event.state.tab);
    });
    return () => {
      close();
      void saveScroll();
    };
  }, [client, windowId]);

  const attach = async (chatId?: string) => {
    if (!tab) return chatId ?? (await client.createChat({ settings: pending })).id;
    const side = await client.openSideChat(tab.id, windowId, chatId, chatId ? undefined : pending);
    setPending({});
    scroll.current = { chatId: side.id, top: side.scrollTop, saved: side.scrollTop };
    await chat.show(chatId ? await client.chat(side.id) : { chat: side, run: null, artifacts: [] });
    return side.id;
  };

  const status = view.run ? (view.run.approval ? "waiting" : "running") : "idle";
  const settings: ChatSettings = view.chat?.settings ?? { ...(info?.defaults ?? { mode: "guard", model: "", effort: "medium", scope: "current" }), ...pending };
  const others = recent.filter((c) => c.id !== view.chat?.id).slice(0, 12);

  return (
    <aside class="side" aria-label="Perch" data-ready={info ? "true" : undefined}>
      <header class="side-h">
        <span class="title">{view.chat?.title ?? "New chat"}</span>
        <PerchDot status={status} />
        {status !== "idle" && <span class="state">{status === "running" ? "Working" : "Waiting for you"}</span>}
        <Menu label="Recent chats" align="end" choices={others.map((c) => ({ value: c.id, label: c.title, hint: c.tab ? "In another tab" : undefined }))} selected={[]} onPick={(c) => void attach(c.value)}>
          <Icon name="history" />
        </Menu>
        <button type="button" class="ib" aria-label="New chat" title="New chat" disabled={!view.chat} onClick={() => void attach()}>
          <Icon name="pen" />
        </button>
        <button type="button" class="ib" aria-label="Close sidebar" title="Close sidebar" onClick={() => host?.close?.()}>
          <Icon name="x" />
        </button>
      </header>
      <Thread
        view={view}
        error={chat.error}
        empty={SIDEBAR_EMPTY}
        onDecide={chat.decide}
        onOpenArtifact={(meta) => (host?.openTab ? host.openTab(meta.url) : window.open(meta.url, "_blank", "noopener,noreferrer"))}
        onScroll={(top) => {
          const s = scroll.current;
          s.top = top;
          clearTimeout(s.timer);
          s.timer = setTimeout(() => void saveScroll(), SCROLL_SAVE_MS);
        }}
      />
      <Composer
        draft={chat.draft}
        onDraft={chat.setDraft}
        onSend={(text) => void chat.send(text, tab ?? undefined, () => attach())}
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
