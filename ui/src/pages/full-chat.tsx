/**
 * The full-page chat (spec 7.6, perch://chat): chat list 200px, the conversation, and the
 * artifact pane 360px and resizable. The list collapses below 1100px.
 */

import { useEffect, useState } from "preact/hooks";
import type { Client } from "../api/client";
import type { AppInfo, ArtifactMeta, ChatSettings, ChatSummary } from "../api/types";
import { ArtifactPane, PANE } from "../components/artifact-pane";
import { ChatList } from "../components/chat-list";
import { Composer } from "../components/composer";
import { Icon, PerchDot } from "../components/icon";
import { Menu } from "../components/menu";
import { Thread } from "../components/thread";
import { applyToList } from "../state/chat";
import { readPref, writePref } from "../state/prefs";
import { useChat } from "../state/use-chat";

const LIST_BREAKPOINT = 1100;
export const EMPTY ="Ask Perch to do something on the web. It works in its own tabs and asks before it sends, buys or deletes anything.";

type Props = { client: Client; initialChat?: string | null; initialAsk?: string | null; onNavigate?: (chatId: string | null) => void };

function saveFile(name: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function FullChat({ client, initialChat = null, initialAsk = null, onNavigate }: Props) {
  const chat = useChat(client);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [list, setList] = useState<ChatSummary[]>([]);
  const [listOpen, setListOpen] = useState(() => window.innerWidth >= LIST_BREAKPOINT && readPref("chat.list", true));
  const [artifact, setArtifact] = useState<ArtifactMeta | null>(null);
  const [width, setWidth] = useState(() => readPref("chat.paneWidth", PANE.initial));
  const [pending, setPending] = useState<Partial<ChatSettings>>({});
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { view } = chat;
  const selected = view.chat?.id ?? null;

  const open = async (id: string | null) => {
    setArtifact(null);
    setConfirmDelete(false);
    setEditing(false);
    await chat.show(id ? await client.chat(id).catch(() => null) : null);
    onNavigate?.(id);
  };

  useEffect(() => {
    void client.info().then(setInfo).catch((e: Error) => chat.setError(e.message));
    void client.chats().then(setList).catch(() => undefined);
    if (initialChat) void open(initialChat);
    return client.connect((event) => {
      setList((l) => applyToList(l, event));
      chat.onEvent(event);
      if (event.type === "chat.removed") chat.setView((v) => (v.chat?.id === event.chatId ? { chat: null, run: null, artifacts: [] } : v));
    });
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
    if (fresh && fresh.versions !== artifact.versions) setArtifact(fresh);
  }, [view.artifacts]);

  // A full-page chat has no tab of its own, so new ones start with the agent's own tabs.
  const settings: ChatSettings = view.chat?.settings ?? { ...(info?.defaults ?? { mode: "guard", model: "", effort: "medium" }), scope: "agent", ...pending };
  const summary = list.find((c) => c.id === selected);
  const status = summary?.status ?? (view.run ? (view.run.approval ? "waiting" : "running") : "idle");

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
    await chat.show({ chat: created, run: null, artifacts: [] });
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
  const exportChat = async () => view.chat && saveFile(`${view.chat.title.replace(/[^\w .-]/g, "_")}.md`, await client.exportChat(view.chat.id));
  const remove = async () => {
    if (!view.chat) return;
    await client.deleteChat(view.chat.id);
    await open(null);
  };

  return (
    <div class="full" data-ready={info ? "true" : undefined}>
      {listOpen && <ChatList chats={list} selected={selected} onSelect={(id) => void open(id)} onNew={() => void open(null)} />}
      <main class="center">
        <header class="fc-h">
          {editing && view.chat ? (
            <input class="title-edit" aria-label="Chat title" value={view.chat.title} autoFocus onBlur={(e) => void rename(e.currentTarget.value)} onKeyDown={(e) => (e.key === "Enter" ? void rename(e.currentTarget.value) : e.key === "Escape" && setEditing(false))} />
          ) : (
            <button type="button" class="title" disabled={!view.chat} title={view.chat ? "Rename" : undefined} onClick={() => setEditing(true)}>
              {view.chat?.title ?? "New chat"}
            </button>
          )}
          <PerchDot status={status} />
          {status !== "idle" && <span class="state">{status === "running" ? "Working" : "Waiting for your approval"}</span>}
          <span class="grow" />
          {view.chat && (
            <Menu label="More" choices={[{ value: "export", label: "Export as Markdown" }, { value: "delete", label: "Delete chat" }]} selected={[]} align="end" onPick={(c) => (c.value === "export" ? void exportChat() : setConfirmDelete(true))}>
              <Icon name="more" />
            </Menu>
          )}
          <button type="button" class="btn small" disabled={!view.chat} onClick={() => void exportChat()} title="Save this chat as a Markdown file">
            Share
          </button>
          <button type="button" class="ib" aria-label="Chat list" aria-pressed={listOpen} onClick={() => setListOpen(writePref("chat.list", !listOpen))}>
            <Icon name="panelleft" />
          </button>
          <button type="button" class="ib" aria-label="Artifacts" aria-pressed={Boolean(artifact)} disabled={!view.artifacts.length} onClick={() => setArtifact(artifact ? null : view.artifacts.at(-1) ?? null)}>
            <Icon name="panel" />
          </button>
        </header>
        {confirmDelete && (
          <div class="confirm" role="alert">
            <span>Delete this chat and its artifacts? This cannot be undone.</span>
            <button type="button" class="btn small danger-text" onClick={() => void remove()}>
              Delete chat
            </button>
            <button type="button" class="btn small" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        )}
        <Thread
          view={view}
          error={chat.error}
          empty={EMPTY}
          selectedArtifact={artifact?.id ?? null}
          onDecide={chat.decide}
          onOpenArtifact={setArtifact}
          onBranch={async (m) => {
            if (!view.chat) return;
            const branch = await client.branch(view.chat.id, m.id);
            await open(branch.id);
          }}
        />
        <Composer
          draft={chat.draft}
          onDraft={chat.setDraft}
          onSend={(text) => void chat.send(text, undefined, create)}
          onStop={() => void chat.stop()}
          running={Boolean(view.run)}
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
