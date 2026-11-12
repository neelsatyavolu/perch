/** The conversation: messages, the run in progress, and the approval card as the only status while it is up. */

import { Fragment, type VNode } from "preact";
import { useCallback, useLayoutEffect, useRef } from "preact/hooks";
import type { ArtifactMeta, ChatMessage } from "../api/types";
import type { ChatView } from "../state/chat";
import { ApprovalCard } from "./approval";
import { PerchMark } from "./icon";
import { ArtifactCard, LiveRun, Message, dayLabel, newDay } from "./message";

type ThreadProps = {
  view: ChatView;
  onDecide: (approvalId: string, approved: boolean) => Promise<void> | void;
  onOpenArtifact: (meta: ArtifactMeta) => void;
  onBranch?: (message: ChatMessage) => void;
  selectedArtifact?: string | null;
  /** Called with the scroll position, for side chats that come back where they were. */
  onScroll?: (top: number) => void;
  error?: string | null;
  /** Shown when the chat has no messages; "" shows nothing, as while the chat is still loading. */
  empty: VNode | string;
};

export function Thread({ view, onDecide, onOpenArtifact, onBranch, selectedArtifact, onScroll, error, empty }: ThreadProps) {
  const box = useRef<HTMLDivElement>(null);
  const pad = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** The message just sent: it scrolls to the top and the reply grows below it, without the view following. */
  const anchor = useRef<string | null>(null);
  const seen = useRef<string | null>(null);
  /** The reply that just finished, and how much of its text the live run had already shown. */
  const fresh = useRef<{ id: string; from: number } | null>(null);
  const liveText = useRef("");
  /** The chat whose run was on screen at the last render. */
  const ranFor = useRef<string | null>(null);
  const chatId = view.chat?.id ?? null;
  const messages = view.chat?.messages ?? [];
  const run = view.run;
  const last = messages.at(-1);

  // While a run works, remember what it has said; when it ends, its reply types on from there.
  if (run) {
    liveText.current = run.text.replace(/^\s*\**\s*title\s*:[^\n]*\n+/i, "").trim();
    ranFor.current = chatId;
  } else if (ranFor.current !== null) {
    if (ranFor.current === chatId && last?.role === "assistant") {
      let i = 0;
      const was = liveText.current;
      while (i < was.length && was[i] === last.text[i]) i++;
      fresh.current = { id: last.id, from: i };
    }
    ranFor.current = null;
  }

  // A chat opens where it was left (or at the bottom); nothing types or anchors from before.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const saved = view.chat?.scrollTop ?? 0;
    el.scrollTop = saved > 0 ? saved : el.scrollHeight;
    pinned.current = saved <= 0;
    anchor.current = null;
    fresh.current = null;
    seen.current = view.chat?.messages.at(-1)?.id ?? null;
    if (pad.current) pad.current.style.height = "0px";
  }, [chatId]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // A new message from the user: bring it to the top of the view, smoothly.
    if (last && last.id !== seen.current && last.role === "user" && seen.current !== null) {
      anchor.current = last.id;
      pinned.current = false;
    }
    if (last) seen.current = last.id;
    const target = anchor.current ? el.querySelector<HTMLElement>(`[data-id="${CSS.escape(anchor.current)}"]`) : null;
    if (target && pad.current) {
      // Room below the sent message so it can sit at the top while the reply is still short.
      const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const below = el.scrollHeight - pad.current.offsetHeight - top;
      pad.current.style.height = `${Math.max(0, el.clientHeight - below - 24)}px`;
      if (target.dataset.anchored !== "1") {
        target.dataset.anchored = "1";
        el.scrollTo({ top: Math.max(0, top - 12), behavior: "smooth" });
      }
    } else if (pinned.current) el.scrollTop = el.scrollHeight;
  });

  // Stable while the artifacts are, so past messages skip re-rendering on every streamed token.
  const artifact = useCallback(
    (id: string) => {
      const meta = view.artifacts.find((a) => a.id === id);
      return meta ? <ArtifactCard meta={meta} onOpen={onOpenArtifact} selected={selectedArtifact === id} /> : <div class="artifact-card missing">This artifact was removed</div>;
    },
    [view.artifacts, selectedArtifact, onOpenArtifact],
  );
  return (
    <div
      class="thread"
      ref={box}
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        onScroll?.(Math.round(el.scrollTop));
      }}
    >
      {messages.length === 0 && !run && empty ? (
        <div class="empty">
          <PerchMark size={32} bare />
          {typeof empty === "string" ? <p>{empty}</p> : empty}
        </div>
      ) : null}
      {messages.map((m, i) => (
        <Fragment key={m.id}>
          {newDay(m.time, messages[i - 1]?.time) && dayLabel(m.time) && <p class="day">{dayLabel(m.time)}</p>}
          <Message message={m} artifact={artifact} onBranch={onBranch} typeFrom={fresh.current?.id === m.id ? fresh.current.from : undefined} />
        </Fragment>
      ))}
      {run && <LiveRun key={run.runId} text={run.text} steps={run.steps} waiting={Boolean(run.approval)} since={run.startedAt} />}
      {run?.approval && <ApprovalCard key={run.approval.id} card={run.approval} onDecide={(ok) => onDecide(run.approval!.id, ok)} />}
      {error && (
        <div class="note error" role="alert">
          {error}
        </div>
      )}
      <div ref={pad} class="thread-pad" aria-hidden="true" />
    </div>
  );
}
