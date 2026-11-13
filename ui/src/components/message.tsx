/** One chat message: the user's bubble, or a reply with its steps, text, artifacts and actions. */

import type { VNode } from "preact";
import { memo } from "./memo";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ArtifactMeta, ChatMessage } from "../api/types";
import { Icon } from "./icon";
import { Markdown } from "./markdown";

/** A step as saved; chats from before step details have plain labels. */
type StepLike = string | { label: string; detail?: string; output?: string };
type StepItem = { label: string; detail?: string; output?: string };
const asStep = (s: StepLike): StepItem => (typeof s === "string" ? { label: s } : s);

/** One step: its label, and when it ran code or a query, a box with that and what came back. */
function StepRow({ step, current }: { step: StepItem; current?: boolean }) {
  const [open, setOpen] = useState(false);
  const more = Boolean(step.detail || step.output);
  const cls = current ? "step current" : "step";
  if (!more) return <li class={cls}><span class="step-l"><span title={step.label}>{step.label}</span></span></li>;
  return (
    <li class={cls}>
      <button type="button" class="step-l more" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span title={step.label}>{step.label}</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <div class="step-box">
          {step.detail && <pre class="step-in">{step.detail}</pre>}
          {step.output && <pre class="step-out">{step.output}</pre>}
        </div>
      )}
    </li>
  );
}

export function StepList({ steps, live = false }: { steps: StepItem[]; live?: boolean }) {
  return (
    <ul class={live ? "steplist now" : "steplist"}>
      {steps.map((s, i) => (
        <StepRow key={i} step={s} current={live && i === steps.length - 1} />
      ))}
    </ul>
  );
}

/** A finished reply's steps, folded into "7 steps" until opened. */
export function Steps({ steps: raw, open: initial = false }: { steps: StepLike[]; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  if (!raw.length) return null;
  const steps = raw.map(asStep);
  return (
    <div class="steps-wrap">
      <button type="button" class="steps" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="right" size={14} />
        <span>{`${steps.length} ${steps.length === 1 ? "step" : "steps"}`}</span>
      </button>
      {open && <StepList steps={steps} />}
    </div>
  );
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * `text` revealed a few characters a frame, so an answer that arrives in one piece reads as typed.
 * Speeds up when far behind, so a long answer never takes more than about a second to catch up.
 */
export function useTyped(text: string, from: number | null): string {
  const [n, setN] = useState(from === null || reducedMotion() ? text.length : from);
  const shown = Math.min(n, text.length);
  useEffect(() => {
    if (shown >= text.length) return;
    const id = requestAnimationFrame(() => setN((k) => Math.min(text.length, k + Math.max(2, Math.ceil((text.length - k) / 45)))));
    return () => cancelAnimationFrame(id);
  }, [text, shown]);
  return text.slice(0, shown);
}

export function ArtifactCard({ meta, onOpen, selected }: { meta: ArtifactMeta; onOpen: (meta: ArtifactMeta) => void; selected?: boolean }) {
  const kind = { html: "Page", markdown: "Document", code: meta.language ? `Code · ${meta.language}` : "Code", svg: "Drawing", csv: "Table", json: "Data", image: "Image" }[meta.kind];
  return (
    <button type="button" class={selected ? "artifact-card sel" : "artifact-card"} onClick={() => onOpen(meta)}>
      <Icon name="panel" />
      <span>
        <span class="t">{meta.title}</span>
        <span class="k">
          {kind} · version {meta.versions}
        </span>
      </span>
    </button>
  );
}

/** The time in the user's own clock style, such as "2:09 AM" or "02:09". */
export function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** The divider above a day's first message: "Today 9:41 AM", "Yesterday 10:52 PM", "Nov 9 8:05 AM" (with the year when it is not this one). */
export function dayLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const day =
    dayKey(d) === dayKey(today)
      ? "Today"
      : dayKey(d) === dayKey(yesterday)
        ? "Yesterday"
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
  return `${day} ${time(iso)}`;
}

/** True when `iso` falls on a different calendar day from `prev` (or there is no `prev`). */
export function newDay(iso: string, prev?: string): boolean {
  if (!prev) return true;
  const a = new Date(iso);
  const b = new Date(prev);
  return Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) ? false : dayKey(a) !== dayKey(b);
}

type MessageProps = {
  message: ChatMessage;
  /** For the reply that just finished: how much of its text was already on screen; the rest types out. */
  typeFrom?: number;
  artifact: (id: string) => VNode | null;
  onBranch?: (message: ChatMessage) => void;
};

/** Memoized: a streamed token re-renders the thread, not every past reply's Markdown. */
export const Message = memo(function Message({ message, artifact, onBranch, typeFrom }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const typed = useTyped(message.role === "assistant" ? message.text : "", typeFrom ?? null);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(message.text.replace(/\[\[artifact:[^\]]+\]\]\n?/g, ""));
    } catch {
      return; // Not copied, so the button does not say it was.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const copyButton = (what: string) => (
    <button type="button" class="ib" aria-label={copied ? "Copied" : `Copy ${what}`} title={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
  if (message.role === "user") {
    return (
      <div class="me-row" data-id={message.id}>
        <span class="me-actions">{copyButton("message")}</span>
        <div class="me">
          {message.scheduled && <span class="me-sched">Sent on schedule</span>}
          {message.text}
          {message.attachments?.length ? (
            <span class="me-files">{message.attachments.map((f) => <span class="chip file" key={f.id}><span class="chip-t">{f.name}</span></span>)}</span>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div class="reply" data-id={message.id}>
      <Steps steps={message.steps ?? []} />
      {typed && <Markdown text={typed} renderArtifact={artifact} />}
      {message.stopped && <div class="note">Stopped</div>}
      {message.error && (
        <div class="note error" role="alert">
          {message.error}
        </div>
      )}
      <div class="meta-row">
        {copyButton("reply")}
        {onBranch && (
          <button type="button" class="ib" aria-label="Branch from here" title="Branch from here" onClick={() => onBranch(message)}>
            <Icon name="branch" size={14} />
          </button>
        )}
        <span class="mono">{time(message.time)}</span>
      </div>
    </div>
  );
});

/** Steps shown while a run works; earlier ones fold behind "Show N earlier steps". */
const LIVE_STEPS = 6;

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The run in progress: how long it has worked, what the agent has said so far, and its steps as a
 * list with the current one marked. Older steps fold away once the list gets long. While an approval
 * waits, every step folds into one line so the card is what the eye lands on.
 */
export function LiveRun({ text, steps: raw, waiting, since }: { text: string; steps: StepLike[]; waiting: boolean; since?: string }) {
  const start = useRef(since ? Date.parse(since) || Date.now() : Date.now());
  const [now, setNow] = useState(Date.now());
  const [all, setAll] = useState(false);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  // The first reply's `Title:` line names the chat; it isn't part of the answer.
  const typed = useTyped(text.replace(/^\s*\**\s*title\s*:[^\n]*\n+/i, ""), 0);
  const steps = raw.map(asStep);
  const hidden = all ? 0 : Math.max(0, steps.length - LIVE_STEPS);
  return (
    <div class="reply live">
      {/* While an approval card is up it is the only status. */}
      {!waiting && (
        <div class="work" role="status">
          <span class="dot live" aria-hidden="true" />
          <span>Working for {elapsed(now - start.current)}</span>
        </div>
      )}
      {typed && <Markdown text={typed} />}
      {waiting ? (
        <Steps steps={steps} />
      ) : (
        steps.length > 0 && (
          <div class="steps-wrap">
            {hidden > 0 && (
              <button type="button" class="steps" onClick={() => setAll(true)}>
                <Icon name="right" size={14} />
                <span>{`Show ${hidden} earlier ${hidden === 1 ? "step" : "steps"}`}</span>
              </button>
            )}
            <StepList steps={steps.slice(hidden)} live />
          </div>
        )
      )}
    </div>
  );
}
