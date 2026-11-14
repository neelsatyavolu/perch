/**
 * The composer (spec 7.6): one box holding the current tab chip, the message field and a single
 * row with attach, the permission mode, the model and effort pickers, and one round button that
 * dictates while the field is empty, sends once there is text, and stops a running task. While a
 * task runs, a message waits its turn (Enter) or steers the task now (⌘↩, or Steer); waiting
 * messages show above the field, each with Send now and Remove.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { petalBurst } from "./petals";
import type { ChatSettings, Effort, Mode, ModelInfo, QueuedMessage, TabInfo } from "../api/types";
import type { PageHost } from "../host/frame-host";
import type { AttachedFile } from "../host/protocol";
import { Icon } from "./icon";
import { applyMention, keptMentions, matchTabs, mentionLabel, mentionQuery } from "./mentions";
import { Menu, type Choice } from "./menu";
import { EffortMenu, takesFastMode } from "./effort-menu";
import { fitEffort, ModelMenu, modelName } from "./model-menu";
import { ProviderMark } from "./provider-mark";

/** What a message carries besides its text. `when`, while a task runs: wait for it, or steer it now. */
export type SendExtras = { files: AttachedFile[]; mentions: TabInfo[]; when?: "queue" | "steer" };

export const PLACEHOLDER = "Ask Perch a task, @ for context";

const MODES: Choice<Mode>[] = [
  { value: "ask", label: "Ask", hint: "Asks before every change" },
  { value: "guard", label: "Guard", hint: "Asks before it sends, buys or deletes" },
  { value: "skip", label: "Skip confirmation", hint: "Runs without asking; payments still ask" },
];

type ComposerProps = {
  draft: string;
  onDraft: (text: string) => void;
  /** Resolving false means it was not sent, so the files and @ picks stay for another try. */
  onSend: (text: string, extras: SendExtras) => Promise<boolean> | void;
  onStop: () => void;
  running: boolean;
  /** Messages waiting behind the running task. */
  queued?: readonly QueuedMessage[];
  onUnqueue?: (id: string) => void;
  onSendNow?: (id: string) => void;
  tab: TabInfo | null;
  settings: ChatSettings;
  models: ModelInfo[];
  onSettings: (patch: Partial<ChatSettings>) => void;
  autoFocus?: boolean;
  /** The browser's file panel and dictation; without them the buttons say why they are off. */
  host?: PageHost;
  /** The open tabs, for `@`. */
  listTabs?: () => Promise<TabInfo[]>;
  /** Attaches a pasted or dropped file (its bytes, base64); without it pasting files is off. */
  uploadFile?: (name: string, base64: string) => Promise<AttachedFile>;
  /** An attached image as a data: URL, for its thumbnail; null for other files. */
  previewFile?: (id: string) => Promise<string | null>;
};

/** A file read in the page: its data: URL (the thumbnail of an image) and its base64 bytes. */
function readFile(file: File): Promise<{ url: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ url, base64: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(new Error(`${file.name || "That file"} couldn't be read`));
    reader.readAsDataURL(file);
  });
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const PASTED_LIMIT = 8 * 1024 * 1024;

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
  /** Thumbnails of attached images, by attachment id. */
  const [thumbs, setThumbs] = useState<Readonly<Record<string, string>>>({});
  const [dropping, setDropping] = useState(false);
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

  /** Sends; while a task runs it waits its turn, or with `steer` stops the task and goes now. */
  const send = (steer = false) => {
    const text = p.draft.trim();
    if (!text) return;
    if (dictating) void stopDictation();
    petalBurst(document.querySelector(".composer .send"));
    const sentFiles = files;
    const sentPicks = picked;
    const when = p.running ? (steer ? "steer" : "queue") : undefined;
    void Promise.resolve(p.onSend(text, { files: sentFiles, mentions: keptMentions(text, sentPicks), ...(when ? { when } : {}) })).then((ok) => {
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
      send(e.metaKey || e.ctrlKey);
    }
  };

  const addFiles = (added: readonly AttachedFile[]) =>
    setFiles((list) => [...list, ...added.filter((f) => !list.some((x) => x.id === f.id))].slice(0, 20));
  const attach = async () => {
    setNote(null);
    try {
      const added = (await p.host?.chooseFiles?.()) ?? [];
      addFiles(added);
      // Picked images get a thumbnail too.
      for (const f of added.filter((x) => IMAGE_NAME.test(x.name))) {
        void p.previewFile?.(f.id).then((url) => url && setThumbs((t) => ({ ...t, [f.id]: url }))).catch(() => undefined);
      }
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  /** Pasted or dropped files: each is uploaded and attached, an image with its thumbnail. */
  const takeFiles = async (list: readonly File[]) => {
    if (!list.length || !p.uploadFile) return;
    setNote(null);
    for (const file of list.slice(0, 20)) {
      if (file.size > PASTED_LIMIT) {
        setNote(`${file.name || "That file"} is over 8 MB. Attach it with + instead.`);
        continue;
      }
      try {
        const { url, base64 } = await readFile(file);
        const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
        const name = file.name && file.name !== "image.png" ? file.name : `Pasted image ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.${ext}`;
        const added = await p.uploadFile(name, base64);
        addFiles([added]);
        if (file.type.startsWith("image/")) setThumbs((t) => ({ ...t, [added.id]: url }));
      } catch (e) {
        setNote((e as Error).message);
      }
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (pasted.length && p.uploadFile) {
      e.preventDefault();
      void takeFiles(pasted);
      return;
    }
    // Files copied in Finder reach the page only as their names: the browser reads the clipboard's
    // file paths and attaches them, and the names typed in by the paste are taken back out.
    if (!p.host?.pastedFiles) return;
    const before = p.draft;
    void p.host.pastedFiles().then((added) => {
      if (!added.length) return;
      addFiles(added);
      p.onDraft(before);
      for (const f of added.filter((x) => IMAGE_NAME.test(x.name))) {
        void p.previewFile?.(f.id).then((url) => url && setThumbs((t) => ({ ...t, [f.id]: url }))).catch(() => undefined);
      }
    });
  };
  const onDrop = (e: DragEvent) => {
    setDropping(false);
    const dropped = [...(e.dataTransfer?.files ?? [])];
    if (!dropped.length || !p.uploadFile) return;
    e.preventDefault();
    void takeFiles(dropped);
  };
  const onDragOver = (e: DragEvent) => {
    if (!p.uploadFile || ![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    e.preventDefault();
    setDropping(true);
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
  const modelLabel = model ? modelName(model.label) : p.models.length ? "Pick a model" : "No model signed in";
  // The round button: stop while a task runs, the microphone while there is nothing to send, send
  // otherwise (with a small microphone beside it, to dictate after what is typed).
  const showMic = !p.running && canDictate && (dictating || !p.draft.trim());
  const typed = Boolean(p.draft.trim());
  const queued = p.queued ?? [];

  return (
    <div class="composer-block">
      {queued.length > 0 && (
        <ol class="queued" aria-label="Messages waiting to send">
          {queued.map((q) => (
            <li key={q.id} class="queued-item">
              <Icon name="history" size={12} />
              <span class="queued-t" title={q.text}>{q.text}</span>
              <button type="button" class="btn quiet small" onClick={() => p.onSendNow?.(q.id)} title="Stop the task and send this now">Send now</button>
              <button type="button" class="ib x" aria-label={`Remove "${q.text.slice(0, 40)}"`} title="Remove" onClick={() => p.onUnqueue?.(q.id)}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div class={`composer${dropping ? " dropping" : ""}`} onDragOver={onDragOver} onDragLeave={() => setDropping(false)} onDrop={onDrop}>
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
              <span class={`chip file${thumbs[f.id] ? " has-thumb" : ""}`} key={f.id} title={f.name}>
                {thumbs[f.id] && <img class="thumb" src={thumbs[f.id]} alt="" />}
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
            {p.tab.favicon ? (
              <img class="fav" src={p.tab.favicon} alt="" />
            ) : (
              <span class="fav">{(host(p.tab.url) || "?").charAt(0).toUpperCase()}</span>
            )}
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
          onPaste={onPaste}
        />
        <div class="crow">
          <button
            type="button"
            class="ib attach"
            aria-label="Attach files"
            title={canAttach ? "Attach files" : "Attaching files works in the Perch build"}
            disabled={!canAttach}
            onClick={() => void attach()}
          >
            <Icon name="plus" />
          </button>
          <Menu label="Permission mode" stacked choices={MODES} selected={[p.settings.mode]} onPick={(c) => p.onSettings({ mode: c.value })}>
            <Icon name="shield" size={14} />
            {/* Ask and Guard fold to the shield in a narrow side chat; Skip confirmation always says so. */}
            <span class={p.settings.mode === "skip" ? undefined : "mode-t"}>{MODES.find((m) => m.value === p.settings.mode)?.label}</span>
          </Menu>
          {note && <span class="cnote" role="status">{note}</span>}
          <div class="grow" />
          <ModelMenu
            models={p.models}
            selected={p.settings.model}
            onPick={(next) => {
              const effort = fitEffort(next.efforts, p.settings.effort);
              p.onSettings({ model: next.id, ...(effort !== p.settings.effort ? { effort } : {}) });
            }}
          >
            {model && <ProviderMark provider={model.provider} size={12} />}
            {modelLabel}
          </ModelMenu>
          {model && model.efforts.length > 0 && (
            <EffortMenu
              efforts={model.efforts}
              effort={p.settings.effort}
              onEffort={(effort) => p.onSettings({ effort })}
              {...(takesFastMode(model.id) ? { fast: p.settings.fast === true, onFast: (fast: boolean) => p.onSettings({ fast }) } : {})}
            />
          )}
          {p.running && typed ? (
            <>
              <button type="button" class="ib" aria-label="Stop task" title="Stop task" onClick={p.onStop}>
                <Icon name="stop" size={14} />
              </button>
              <button type="button" class="btn quiet small steer" title="Stop the task and send this now (⌘↩)" onClick={() => send(true)}>
                Steer
              </button>
              <button type="button" class="ib send" aria-label="Queue message" title="Send when the task finishes (↩)" onClick={() => send()}>
                <Icon name="send" />
              </button>
            </>
          ) : p.running ? (
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
              <button type="button" class="ib send" aria-label="Send message" title="Send message" disabled={!typed} onClick={() => send()}>
                <Icon name="send" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
