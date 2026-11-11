import { useState } from "preact/hooks";
import type { ChatEffort, Composer as ComposerState, PermissionMode, Query, SearchEngine } from "../../api";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Icon, Search } from "../../ui/icons";
import { Segmented } from "../../ui/Segmented";

type Mode = Query["mode"];

/**
 * The new tab page's "Search or ask" box (spec 5.5). Enter searches with Brave, Tab while typing
 * switches that query to Google (Tab again or Backspace at the start switches back), ⌘Enter asks
 * Perch. Escape clears. Tab in an empty box moves focus as usual.
 */
export function AddressBox({ onSubmit }: { readonly onSubmit: (q: Query) => void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("search");
  const [engine, setEngine] = useState<SearchEngine>("brave");
  const composer = useComposer();

  const submit = (asMode: Mode) => {
    const clean = text.trim();
    if (clean) onSubmit({ text: clean, mode: asMode, engine: asMode === "ask" ? "brave" : engine });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === "Enter") {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey ? "ask" : mode);
    } else if (e.key === "Tab" && !e.shiftKey && mode === "search" && text.trim()) {
      e.preventDefault();
      setEngine((x) => (x === "google" ? "brave" : "google"));
    } else if (e.key === "Backspace" && engine === "google" && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      setEngine("brave");
    } else if (e.key === "Escape" && text) {
      e.preventDefault();
      setText("");
      setEngine("brave");
    }
  };

  return (
    <div class="addr">
      <div class="box">
        <Icon of={Search} />
        {engine === "google" && mode === "search" && <span class="engine-chip">Google</span>}
        <input
          type="search"
          aria-label="Search or ask"
          aria-describedby="addr-hints"
          placeholder={mode === "ask" ? "Ask Perch a task" : "Search or ask"}
          value={text}
          autoFocus
          spellcheck={false}
          autoComplete="off"
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={onKeyDown}
        />
        <Segmented class="mode" label="Search or ask" value={mode} onChange={setMode} options={[{ value: "search", label: "Search" }, { value: "ask", label: "Ask" }]} />
      </div>
      <div class="composer">
        <Composer side="mode" composer={composer} />
        <p class="hints" id="addr-hints">
          <kbd class="key">Tab</kbd> <span>Google</span> <span aria-hidden="true">·</span> <kbd class="key" aria-label="Command Return">⌘↵</kbd> <span>Ask</span>
        </p>
        <Composer side="model" composer={composer} />
      </div>
    </div>
  );
}

const MODE_NAMES: Readonly<Record<PermissionMode, string>> = { ask: "Ask before actions", guard: "Ask before sends", skip: "Skip confirmation" };
const EFFORT_NAMES: Readonly<Record<ChatEffort, string>> = { low: "Low", medium: "Medium", high: "High" };

/**
 * What a task asked here starts with, as in a chat's composer: the permission mode on the left,
 * the model and its effort on the right. Each choice is kept for the next task.
 */
function useComposer() {
  const api = useApi();
  const act = useAction();
  const state = useLoad((a) => a.getComposer());
  const save = async (patch: Partial<Pick<ComposerState, "model" | "effort" | "mode">>) => {
    const next = await act(() => api.setComposer(patch));
    if (next) state.set(next);
  };
  return { c: state.data, save };
}

function Composer({ side, composer }: { readonly side: "mode" | "model"; readonly composer: ReturnType<typeof useComposer> }) {
  const { c, save } = composer;
  if (!c) return <span class={`composer-${side}`} />;
  if (side === "mode") {
    return (
      <span class="composer-mode">
        <select class="picker quiet" aria-label="Permission for the task" value={c.mode} onChange={(e) => void save({ mode: e.currentTarget.value as PermissionMode })}>
          {(Object.keys(MODE_NAMES) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_NAMES[m]}</option>)}
        </select>
      </span>
    );
  }
  if (!c.models.length) return <span class="composer-model" />;
  const providers = [...new Set(c.models.map((m) => m.provider))];
  const efforts = c.models.find((m) => m.id === c.model)?.efforts ?? [];
  return (
    <span class="composer-model">
      <select class="picker quiet" aria-label="Model for the task" value={c.model} onChange={(e) => void save({ model: e.currentTarget.value })}>
        {providers.map((p) => (
          <optgroup key={p} label={p}>
            {c.models.filter((m) => m.provider === p).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </optgroup>
        ))}
      </select>
      {efforts.length > 0 && (
        <select class="picker quiet" aria-label="Effort" value={c.effort} onChange={(e) => void save({ effort: e.currentTarget.value as ChatEffort })}>
          {efforts.map((x) => <option key={x} value={x}>{EFFORT_NAMES[x]}</option>)}
        </select>
      )}
    </span>
  );
}
