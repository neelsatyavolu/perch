/**
 * The composer (spec 7.6): the current tab chip, the message field, attach and dictate, send or
 * stop, and under it the real mode, tab scope and model pickers.
 */

import { useEffect, useRef } from "preact/hooks";
import type { ChatSettings, Effort, Mode, ModelInfo, Scope, TabInfo } from "../api/types";
import { Icon } from "./icon";
import { Menu, type Choice } from "./menu";

export const PLACEHOLDER = "Ask Perch a task, @ for context";

const MODES: Choice<Mode>[] = [
  { value: "ask", label: "Ask", hint: "Asks before every change" },
  { value: "guard", label: "Guard", hint: "Asks before it sends, buys or deletes" },
  { value: "skip", label: "Skip confirmation", hint: "Runs without asking; payments still ask" },
];
const SCOPES: Choice<Scope>[] = [
  { value: "current", label: "Current tab", hint: "The tab this chat is in" },
  { value: "all", label: "All tabs", hint: "Any tab you have open" },
  { value: "agent", label: "New agent tabs", hint: "Only tabs the agent opens" },
];
const EFFORT_LABEL: Record<Effort, string> = { low: "low", medium: "medium", high: "high" };

type ComposerProps = {
  draft: string;
  onDraft: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  running: boolean;
  tab: TabInfo | null;
  settings: ChatSettings;
  models: ModelInfo[];
  onSettings: (patch: Partial<ChatSettings>) => void;
  autoFocus?: boolean;
};

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

  const send = () => {
    const text = p.draft.trim();
    if (!text || p.running) return;
    p.onSend(text);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const model = p.models.find((m) => m.id === p.settings.model);
  const modelChoices: Choice<string>[] = [
    ...p.models.map((m) => ({ value: `model:${m.id}`, label: m.label, hint: m.provider, group: "Model" })),
    ...(model?.efforts ?? []).map((e) => ({ value: `effort:${e}`, label: EFFORT_LABEL[e], group: "Effort" })),
  ];
  const modelLabel = model ? `${model.label} · ${p.settings.effort}` : p.models.length ? "Pick a model" : "No model signed in";

  return (
    <div class="composer-block">
      <div class="composer">
        {p.tab && p.settings.scope === "current" && (
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
          <button type="button" class="ib" aria-label="Attach files" title="Attaching files arrives with the Perch build" disabled>
            <Icon name="plus" />
          </button>
          <div class="grow" />
          <button type="button" class="ib" aria-label="Dictate" title="Dictation arrives with the Perch build" disabled>
            <Icon name="mic" />
          </button>
          {p.running ? (
            <button type="button" class="ib send stop" aria-label="Stop task" title="Stop task" onClick={p.onStop}>
              <Icon name="stop" />
            </button>
          ) : (
            <button type="button" class="ib send" aria-label="Send message" title="Send message" disabled={!p.draft.trim()} onClick={send}>
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
      <div class="under">
        <Menu label="Permission mode" choices={MODES} selected={[p.settings.mode]} onPick={(c) => p.onSettings({ mode: c.value })}>
          <Icon name="shield" size={13} />
          {MODES.find((m) => m.value === p.settings.mode)?.label}
        </Menu>
        <Menu label="Tabs the agent may use" choices={SCOPES} selected={[p.settings.scope]} onPick={(c) => p.onSettings({ scope: c.value })}>
          {SCOPES.find((s) => s.value === p.settings.scope)?.label}
        </Menu>
        <span class="grow" />
        <Menu
          label="Model and effort"
          mono
          align="end"
          choices={modelChoices}
          selected={[`model:${p.settings.model}`, `effort:${p.settings.effort}`]}
          onPick={(c) => {
            const [kind, value] = [c.value.slice(0, c.value.indexOf(":")), c.value.slice(c.value.indexOf(":") + 1)];
            if (kind === "model") {
              const next = p.models.find((m) => m.id === value);
              p.onSettings({ model: value, ...(next && !next.efforts.includes(p.settings.effort) ? { effort: next.efforts[0] ?? "medium" } : {}) });
            } else p.onSettings({ effort: value as Effort });
          }}
        >
          {modelLabel}
        </Menu>
      </div>
    </div>
  );
}
