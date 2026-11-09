/**
 * The composer (spec 7.6): one box holding the current tab chip, the message field and a single
 * row with attach, the permission mode, the model and effort pickers, and one round button that
 * dictates while the field is empty, sends once there is text, and stops a running task.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatSettings, Effort, Mode, ModelInfo, TabInfo } from "../api/types";
import type { PageHost } from "../host/frame-host";
import type { AttachedFile } from "../host/protocol";
import { Icon } from "./icon";
import { applyMention, keptMentions, matchTabs, mentionLabel, mentionQuery } from "./mentions";
import { Menu, type Choice } from "./menu";
import { ProviderMark } from "./provider-mark";

/** What a message carries besides its text. */
export type SendExtras = { files: AttachedFile[]; mentions: TabInfo[] };

export const PLACEHOLDER = "Ask Perch a task, @ for context";

const MODES: Choice<Mode>[] = [
  { value: "ask", label: "Ask", hint: "Asks before every change" },
  { value: "guard", label: "Guard", hint: "Asks before it sends, buys or deletes" },
  { value: "skip", label: "Skip confirmation", hint: "Runs without asking; payments still ask" },
];
const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High" };

type ComposerProps = {
  draft: string;
  onDraft: (text: string) => void;
  /** Resolving false means it was not sent, so the files and @ picks stay for another try. */
  onSend: (text: string, extras: SendExtras) => Promise<boolean> | void;
  onStop: () => void;
  running: boolean;
  tab: TabInfo | null;
  settings: ChatSettings;
  models: ModelInfo[];
  onSettings: (patch: Partial<ChatSettings>) => void;
  autoFocus?: boolean;
  /** The browser's file panel and dictation; without them the buttons say why they are off. */
  host?: PageHost;
  /** The open tabs, for `@`. */
  listTabs?: () => Promise<TabInfo[]>;
  /** The live thumbnail of the tab the running task drives (a base64 JPEG). */
  frame?: string | null;
};

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function Composer(p: ComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [p.draft]);
  useEffect(() => {
    if (p.autoFocus) field.current?.focus();
  }, []);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [picked, setPicked] = useState<TabInfo[]>([]);
  const [tabs, setTabs] = useState<TabInfo[] | null>(null);
  const [active, setActive] = useState(0);
  const [dictating, setDictating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const dictationBase = useRef("");
  const dictatingNow = useRef(false);
  dictatingNow.current = dictating;
  // Dictation writes into this composer's draft, so it stops when the composer goes away.
  useEffect(() => () => void (dictatingNow.current && p.host?.stopDictation?.().catch(() => undefined)), []);

  const query = p.listTabs ? mentionQuery(p.draft) : null;
  const choices = query !== null && tabs ? matchTabs(tabs, query) : [];
  useEffect(() => {
    if (query !== null && !tabs) void p.listTabs?.().then(setTabs, () => setTabs([]));
    if (query === null && tabs) setTabs(null);
    setActive(0);
  }, [query === null]);

  const pick = (tab: TabInfo) => {
    p.onDraft(applyMention(p.draft, tab));
    setPicked((list) => [...list.filter((t) => t.id !== tab.id), tab]);
    field.current?.focus();
  };

  const send = () => {
    const text = p.draft.trim();
    if (!text || p.running) return;
    if (dictating) void stopDictation();
    const sentFiles = files;
    const sentPicks = picked;
    void Promise.resolve(p.onSend(text, { files: sentFiles, mentions: keptMentions(text, sentPicks) })).then((ok) => {
      if (ok === false) return;
      setFiles((list) => list.filter((f) => !sentFiles.includes(f)));
      setPicked((list) => list.filter((t) => !sentPicks.includes(t)));
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (choices.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
        e.preventDefault();
        pick(choices[active] ?? choices[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTabs([]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const attach = async () => {
    setNote(null);
    try {
      const added = (await p.host?.chooseFiles?.()) ?? [];
      setFiles((list) => [...list, ...added.filter((f) => !list.some((x) => x.id === f.id))].slice(0, 20));
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const stopDictation = async () => {
    setDictating(false);
    await p.host?.stopDictation?.().catch(() => undefined);
  };
  const dictate = async () => {
    if (dictating) return stopDictation();
    setNote(null);
    const base = p.draft && !/\s$/.test(p.draft) ? `${p.draft} ` : p.draft;
    dictationBase.current = base;
    setDictating(true);
    try {
      await p.host?.startDictation?.((text, final) => {
        p.onDraft(dictationBase.current + text);
        if (final) setDictating(false);
      });
    } catch (e) {
      setDictating(false);
      setNote((e as Error).message);
    }
  };
  const canAttach = Boolean(p.host?.chooseFiles);
  const canDictate = Boolean(p.host?.startDictation);
  const model = p.models.find((m) => m.id === p.settings.model);
  const modelChoices: Choice<string>[] = p.models.map((m) => ({ value: m.id, label: m.label, hint: m.provider, icon: <ProviderMark provider={m.provider} /> }));
  const effortChoices: Choice<Effort>[] = (model?.efforts ?? []).map((e) => ({ value: e, label: EFFORT_LABEL[e] }));
  const modelLabel = model ? model.label : p.models.length ? "Pick a model" : "No model signed in";
  // The round button: stop while a task runs, the microphone while there is nothing to send, send
  // otherwise (with a small microphone beside it, to dictate after what is typed).
  const showMic = !p.running && canDictate && (dictating || !p.draft.trim());

  return (
    <div class="composer-block">
      {p.running && p.frame && <img class="live-thumb" src={`data:image/jpeg;base64,${p.frame}`} alt="The tab the agent is working in, live" />}
      <div class="composer">
        {choices.length > 0 && (
          <ul class="menu start mentions" role="listbox" aria-label="Tabs to mention">
            {choices.map((t, i) => (
              <li
                key={t.id}
                role="option"
                class={i === active ? "active" : undefined}
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(t);
                }}
              >
                <span class="opt-label">{mentionLabel(t)}</span>
                <span class="opt-hint">{host(t.url)}</span>
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 && (
          <div class="files">
            {files.map((f) => (
              <span class="chip file" key={f.id} title={f.name}>
                <span class="chip-t">{f.name}</span>
                <span class="d">{fileSize(f.size)}</span>
                <button type="button" class="ib x" aria-label={`Remove ${f.name}`} onClick={() => setFiles((list) => list.filter((x) => x.id !== f.id))}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {p.tab && (
          <span class="chip" title={p.tab.url}>
            <span class="fav">{(host(p.tab.url) || "?").charAt(0).toUpperCase()}</span>
            <span class="chip-t">{p.tab.title || "Untitled"}</span>
            <span class="d">{host(p.tab.url)}</span>
          </span>
        )}
        <textarea
          ref={field}
          class="field"
          rows={1}
          value={p.draft}
          placeholder={PLACEHOLDER}
          aria-label="Message"
          onInput={(e) => p.onDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKey}
        />
        <div class="crow">
          <button
            type="button"
            class="ib"
            aria-label="Attach files"
            title={canAttach ? "Attach files" : "Attaching files works in the Perch build"}
            disabled={!canAttach}
            onClick={() => void attach()}
          >
            <Icon name="plus" />
          </button>
          <Menu label="Permission mode" choices={MODES} selected={[p.settings.mode]} onPick={(c) => p.onSettings({ mode: c.value })}>
            <Icon name="shield" size={13} />
            {MODES.find((m) => m.value === p.settings.mode)?.label}
          </Menu>
          {note && <span class="cnote" role="status">{note}</span>}
          <div class="grow" />
          <Menu
            label="Model"
            align="end"
            choices={modelChoices}
            selected={[p.settings.model]}
            onPick={(c) => {
              const next = p.models.find((m) => m.id === c.value);
              p.onSettings({ model: c.value, ...(next && !next.efforts.includes(p.settings.effort) ? { effort: next.efforts[0] ?? "medium" } : {}) });
            }}
          >
            {model && <ProviderMark provider={model.provider} size={12} />}
            {modelLabel}
          </Menu>
          {effortChoices.length > 0 && (
            <Menu label="Effort" align="end" choices={effortChoices} selected={[p.settings.effort]} onPick={(c) => p.onSettings({ effort: c.value })}>
              {EFFORT_LABEL[p.settings.effort]}
            </Menu>
          )}
          {p.running ? (
            <button type="button" class="ib send stop" aria-label="Stop task" title="Stop task" onClick={p.onStop}>
              <Icon name="stop" />
            </button>
          ) : showMic ? (
            <button
              type="button"
              class="ib send"
              aria-label={dictating ? "Stop dictation" : "Dictate"}
              aria-pressed={dictating}
              title={dictating ? "Stop dictation" : "Dictate (on this Mac, nothing leaves it)"}
              onClick={() => void dictate()}
            >
              <Icon name="mic" />
            </button>
          ) : (
            <>
              {canDictate && (
                <button type="button" class="ib" aria-label="Dictate" title="Dictate (on this Mac, nothing leaves it)" onClick={() => void dictate()}>
                  <Icon name="mic" />
                </button>
              )}
              <button type="button" class="ib send" aria-label="Send message" title="Send message" disabled={!p.draft.trim()} onClick={send}>
                <Icon name="send" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
