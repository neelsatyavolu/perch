/**
 * The full-page chat (spec 7.6, perch://chat): chat list 264px, the conversation, and the
 * artifact pane 360px and resizable. The list collapses below 1100px.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Client } from "../api/client";
import type { AppInfo, ArtifactMeta, ChatMessage, ChatSettings, ChatSummary } from "../api/types";
import { ArtifactPane, PANE } from "../components/artifact-pane";
import { ChatList } from "../components/chat-list";
import { Composer } from "../components/composer";
import { Icon, PerchDot } from "../components/icon";
import { OutputsPanel } from "../components/files";
import { Menu } from "../components/menu";
import { Thread } from "../components/thread";
import { applyToList } from "../state/chat";
import { readPref, writePref } from "../state/prefs";
import { useChat } from "../state/use-chat";
import type { PageHost } from "../host/frame-host";

const LIST_BREAKPOINT = 1100;
export const EMPTY ="Ask Perch to do something on the web. It works in its own tabs and asks before it sends, buys or deletes anything.";

type Props = { client: Client; initialChat?: string | null; initialAsk?: string | null; onNavigate?: (chatId: string | null) => void; host?: PageHost };

function saveFile(name: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function FullChat({ client, initialChat = null, initialAsk = null, onNavigate, host }: Props) {
  const chat = useChat(client);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [list, setList] = useState<ChatSummary[]>([]);
  const [listOpen, setListOpen] = useState(() => window.innerWidth >= LIST_BREAKPOINT && readPref("chat.list", true));
  const [artifact, setArtifact] = useState<ArtifactMeta | null>(null);
  const [outputs, setOutputs] = useState(false);
  const [width, setWidth] = useState(() => readPref("chat.paneWidth", PANE.initial));
  const [pending, setPending] = useState<Partial<ChatSettings>>({});
  // A pick in any composer: new chats start with it, and an unsent pick here gives way to it.
  const followDefaults = (defaults: ChatSettings) => {
    setInfo((i) => (i ? { ...i, defaults } : i));
    setPending(({ model: _model, effort: _effort, ...rest }) => rest);
  };
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The delete bar's safe button: it takes focus when the bar opens, so a keyboard user lands in it. */
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmDelete) keep.current?.focus();
  }, [confirmDelete]);
  const { view } = chat;
  const selected = view.chat?.id ?? null;
  /** Counts opens, so a slow load never replaces a chat opened after it. */
  const opening = useRef(0);

  const open = async (id: string | null) => {
    const n = ++opening.current;
    setArtifact(null);
    setOutputs(false);
    setConfirmDelete(false);
    setEditing(false);
    const payload = id ? await client.chat(id).catch(() => null) : null;
    if (n !== opening.current) return;
    chat.show(payload);
    onNavigate?.(id);
  };

  useEffect(() => {
    void client.info().then(setInfo).catch((e: Error) => chat.setError(e.message));
    void client.chats().then(setList).catch(() => undefined);
    if (initialChat) void open(initialChat);
    let dropped = false;
    return client.connect(
      (event) => {
        setList((l) => applyToList(l, event));
        chat.onEvent(event);
        if (event.type === "defaults") followDefaults(event.defaults);
      },
      (connected) => {
        if (!connected) dropped = true;
        else if (dropped) {
          dropped = false;
          // Events sent while the stream was down are lost: reload the list and the open chat.
          void client.chats().then(setList).catch(() => undefined);
          const id = chat.unsent().chatId;
          if (id)
            void client
              .chat(id)
              .then((p) => p.chat && chat.unsent().chatId === p.chat.id && chat.setView({ chat: p.chat, run: p.run, artifacts: p.artifacts, queued: p.run?.queued ?? [] }))
              .catch(() => undefined);
        }
      },
    );
  }, [client]);

  // The chat list collapses when the window gets narrower than 1100px; the toggle still opens it.
  useEffect(() => {
    let wide = window.innerWidth >= LIST_BREAKPOINT;
    const onResize = () => {
      const now = window.innerWidth >= LIST_BREAKPOINT;
      if (wide && !now) setListOpen(false);
      wide = now;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!artifact) return;
    const fresh = view.artifacts.find((a) => a.id === artifact.id);
    // Deleted: the pane closes. A new version or name: the pane follows it.
    if (!fresh) setArtifact(null);
    else if (fresh.versions !== artifact.versions || fresh.title !== artifact.title) setArtifact(fresh);
  }, [view.artifacts]);

  // A full-page chat has no tab of its own, so new ones start with the agent's own tabs.
  const settings: ChatSettings = view.chat?.settings ?? { ...(info?.defaults ?? { mode: "guard", model: "", effort: "medium" }), scope: "agent", ...pending };
  const summary = list.find((c) => c.id === selected);
  const status = summary?.status ?? (view.run ? (view.run.approval ? "waiting" : "running") : "idle");
  // A reply that arrives while the chat is on screen has been seen.
  useEffect(() => {
    if (selected && summary?.unread && document.visibilityState === "visible") void client.patchChat(selected, { read: true }).catch(() => undefined);
  }, [selected, summary?.unread]);

  // Ask from the new tab page: a new chat that starts with the question, once the defaults
  // (the model above all) are known.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!info || asked || initialChat || !initialAsk?.trim()) return;
    setAsked(true);
    void chat.send(initialAsk.trim(), undefined, create);
  }, [info]);

  const create = async () => {
    const created = await client.createChat({ settings });
    setPending({});
    ++opening.current;
    chat.show({ chat: created, run: null, artifacts: [] });
    onNavigate?.(created.id);
    return created.id;
  };
  const rename = async (title: string) => {
    setEditing(false);
    if (view.chat && title.trim() && title.trim() !== view.chat.title) {
      const updated = await client.patchChat(view.chat.id, { title: title.trim() });
      chat.setView((v) => (v.chat ? { ...v, chat: { ...v.chat, title: updated.title } } : v));
    }
  };
  const commitTitle = (title: string) => void chat.run(() => rename(title));
  const togglePin = async () => {
    if (view.chat) await client.patchChat(view.chat.id, { pinned: !summary?.pinned });
  };
  const exportChat = async () => view.chat && saveFile(`${view.chat.title.replace(/[^\w .-]/g, "_")}.md`, await client.exportChat(view.chat.id));
  const remove = async () => {
    if (!view.chat) return;
    await client.deleteChat(view.chat.id);
    await open(null);
  };
  const chatId = view.chat?.id;
  const branch = useCallback(
    (m: ChatMessage) =>
      void chat.run(async () => {
        if (!chatId) return;
        const created = await client.branch(chatId, m.id);
        await open(created.id);
      }),
    [client, chatId],
  );

  return (
    <div class="full" data-ready={info ? "true" : undefined}>
      {listOpen && <ChatList chats={list} selected={selected} onSelect={(id) => void open(id)} onNew={() => void open(null)} onSettings={host?.openSettings} />}
      <main class="center">
        <header class="fc-h">
          <button type="button" class="ib" aria-label="Chat list" title={listOpen ? "Hide chats" : "Show chats"} aria-pressed={listOpen} onClick={() => setListOpen(writePref("chat.list", !listOpen))}>
            <Icon name="panelleft" />
          </button>
          {editing && view.chat ? (
            <input class="title-edit" aria-label="Chat title" value={view.chat.title} autoFocus onBlur={(e) => commitTitle(e.currentTarget.value)} onKeyDown={(e) => (e.key === "Enter" ? commitTitle(e.currentTarget.value) : e.key === "Escape" && setEditing(false))} />
          ) : (
            <button type="button" class="title" disabled={!view.chat} title={view.chat ? "Rename" : undefined} onClick={() => setEditing(true)}>
              {view.chat?.title ?? "New chat"}
            </button>
          )}
          {view.chat && !editing && (
            <button type="button" class="ib" aria-label="Rename" title="Rename" onClick={() => setEditing(true)}>
              <Icon name="pen" />
            </button>
          )}
          {view.chat && (
            <Menu
              label="More"
              choices={[
                { value: "pin", label: summary?.pinned ? "Unpin chat" : "Pin chat" },
                { value: "delete", label: "Delete chat" },
              ]}
              selected={[]}
              onPick={(c) => (c.value === "pin" ? void chat.run(togglePin) : setConfirmDelete(true))}
            >
              <Icon name="more" />
            </Menu>
          )}
          <PerchDot status={status} />
          {status !== "idle" && <span class="state">{status === "running" ? "Working" : "Waiting for your approval"}</span>}
          <span class="grow" />
          {/* Both show only when there is something to act on, as in Aside. */}
          {view.chat?.messages.length ? (
            <button type="button" class="btn small quiet" onClick={() => void chat.run(exportChat)} title="Save this chat as a Markdown file">
              <Icon name="download" />
              Export
            </button>
          ) : null}
          {view.artifacts.length > 0 && (
            <button type="button" class="ib" aria-label="Outputs" title={outputs ? "Hide files" : "Files Perch made"} aria-pressed={outputs} onClick={() => setOutputs(!outputs)}>
              <Icon name="files" />
            </button>
          )}
        </header>
        {outputs && view.artifacts.length > 0 && (
          <OutputsPanel client={client} artifacts={view.artifacts} selected={artifact?.id ?? null} onOpen={setArtifact} onClose={() => setOutputs(false)} />
        )}
        {confirmDelete && (
          <div class="confirm" role="alert">
            <span>Delete this chat and its artifacts? This cannot be undone.</span>
            <button type="button" class="btn small danger-text" onClick={() => void chat.run(remove)}>
              Delete chat
            </button>
            <button ref={keep} type="button" class="btn small outline" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        )}
        <Thread
          client={client}
          view={view}
          error={chat.error}
          empty={EMPTY}
          selectedArtifact={artifact?.id ?? null}
          onDecide={chat.decide}
          onOpenArtifact={setArtifact}
          onBranch={branch}
        />
        <Composer
          draft={chat.draft}
          onDraft={chat.setDraft}
          onSend={(text, extras) => chat.send(text, undefined, create, extras)}
          host={host}
          listTabs={() => client.tabs()}
          onStop={() => void chat.stop()}
          running={Boolean(view.run)}
          queued={view.queued}
          onUnqueue={(id) => void chat.unqueue(id)}
          onSendNow={(id) => void chat.sendQueuedNow(id)}
          tab={null}
          settings={settings}
          models={info?.models ?? []}
          onSettings={(patch) => void chat.setSettings(patch, (p) => setPending((s) => ({ ...s, ...p })))}
          autoFocus
        />
      </main>
      {artifact && <ArtifactPane client={client} meta={artifact} width={width} onWidth={(w) => setWidth(writePref("chat.paneWidth", w))} onClose={() => setArtifact(null)} />}
    </div>
  );
}
