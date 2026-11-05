/** One chat message: the user's bubble, or a reply with its steps, text, artifacts and actions. */

import type { VNode } from "preact";
import { useState } from "preact/hooks";
import type { ArtifactMeta, ChatMessage } from "../api/types";
import { Icon } from "./icon";
import { Markdown } from "./markdown";

export function Steps({ steps, open: initial = false }: { steps: string[]; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  if (!steps.length) return null;
  const summary = `${steps.length} ${steps.length === 1 ? "step" : "steps"} · ${steps.at(-1)}`;
  return (
    <div class="steps-wrap">
      <button type="button" class="steps" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="right" size={14} />
        <span>{summary}</span>
      </button>
      {open && (
        <ul class="steplist">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
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

export function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type MessageProps = {
  message: ChatMessage;
  artifact: (id: string) => VNode | null;
  onBranch?: (message: ChatMessage) => void;
};

export function Message({ message, artifact, onBranch }: MessageProps) {
  const [copied, setCopied] = useState(false);
  if (message.role === "user") {
    return (
      <div class="me" data-id={message.id}>
        {message.text}
      </div>
    );
  }
  const copy = async () => {
    await navigator.clipboard?.writeText(message.text.replace(/\[\[artifact:[^\]]+\]\]\n?/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class="reply" data-id={message.id}>
      <Steps steps={message.steps ?? []} />
      {message.text && <Markdown text={message.text} renderArtifact={artifact} />}
      {message.stopped && <div class="note">Stopped</div>}
      {message.error && (
        <div class="note error" role="alert">
          {message.error}
        </div>
      )}
      <div class="meta-row">
        <button type="button" class="ib" aria-label={copied ? "Copied" : "Copy reply"} title={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
          <Icon name={copied ? "check" : "copy"} size={14} />
        </button>
        {onBranch && (
          <button type="button" class="ib" aria-label="Branch from here" title="Branch from here" onClick={() => onBranch(message)}>
            <Icon name="branch" size={14} />
          </button>
        )}
        <span class="mono">{time(message.time)}</span>
      </div>
    </div>
  );
}

/** The run in progress: streamed text and the live step line with the perch dot. */
export function LiveRun({ text, steps, waiting }: { text: string; steps: string[]; waiting: boolean }) {
  return (
    <div class="reply live">
      {/* While an approval card is up it is the only status, so the last step joins the list. */}
      <Steps steps={waiting ? steps : steps.slice(0, -1)} />
      {text && <Markdown text={text} />}
      {!waiting && (
        <div class="work" role="status">
          <span class="dot live" aria-hidden="true" />
          <span>{steps.at(-1) ?? "Working"}</span>
        </div>
      )}
    </div>
  );
}
