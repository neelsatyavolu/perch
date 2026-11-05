/** The conversation: messages, the run in progress, and the approval card as the only status while it is up. */

import type { VNode } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { ArtifactMeta, ChatMessage } from "../api/types";
import type { ChatView } from "../state/chat";
import { ApprovalCard } from "./approval";
import { PerchMark } from "./icon";
import { ArtifactCard, LiveRun, Message } from "./message";

type ThreadProps = {
  view: ChatView;
  onDecide: (approvalId: string, approved: boolean) => Promise<void> | void;
  onOpenArtifact: (meta: ArtifactMeta) => void;
  onBranch?: (message: ChatMessage) => void;
  selectedArtifact?: string | null;
  /** Called with the scroll position, for side chats that come back where they were. */
  onScroll?: (top: number) => void;
  error?: string | null;
  empty: VNode | string;
};

export function Thread({ view, onDecide, onOpenArtifact, onBranch, selectedArtifact, onScroll, error, empty }: ThreadProps) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const chatId = view.chat?.id ?? null;

  // A chat opens where it was left; afterwards new output keeps the view at the bottom.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const saved = view.chat?.scrollTop ?? 0;
    el.scrollTop = saved > 0 ? saved : el.scrollHeight;
    pinned.current = saved <= 0;
  }, [chatId]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const artifact = (id: string) => {
    const meta = view.artifacts.find((a) => a.id === id);
    return meta ? <ArtifactCard meta={meta} onOpen={onOpenArtifact} selected={selectedArtifact === id} /> : <div class="artifact-card missing">This artifact was removed</div>;
  };
  const messages = view.chat?.messages ?? [];
  const run = view.run;
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
      {messages.length === 0 && !run ? (
        <div class="empty">
          <PerchMark size={48} />
          {typeof empty === "string" ? <p>{empty}</p> : empty}
        </div>
      ) : null}
      {messages.map((m) => (
        <Message key={m.id} message={m} artifact={artifact} onBranch={onBranch} />
      ))}
      {run && <LiveRun text={run.text} steps={run.steps} waiting={Boolean(run.approval)} />}
      {run?.approval && <ApprovalCard key={run.approval.id} card={run.approval} onDecide={(ok) => onDecide(run.approval!.id, ok)} />}
      {error && (
        <div class="note error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
