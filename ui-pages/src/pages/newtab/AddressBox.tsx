import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AddressMatch, ChatEffort, Composer as ComposerState, PermissionMode, Query, SearchEngine } from "../../api";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Globe, Icon, Search } from "../../ui/icons";
import { EFFORT_NAMES, ModelMenu, modelName } from "../../ui/ModelMenu";
import { ProviderGlyph } from "../../ui/ProviderMark";
import { Segmented } from "../../ui/Segmented";
import { useAddressSuggest } from "./useAddressSuggest";

type Mode = Query["mode"];

/**
 * The new tab page's "Search or ask" box (spec 5.5). In Search it works as a second address bar:
 * the browser's own suggestions as you type, the top site completed inline, ↑↓ to pick, Enter to
 * open a site or search (Tab first switches that search to Google; Tab again or Backspace at the
 * start switches back). Ask (or ⌘Enter) hands the text to Perch as a task. Escape closes the
 * suggestions, then clears. Tab in an empty box moves focus as usual.
 */
export function AddressBox({ onSubmit }: { readonly onSubmit: (q: Query) => void }) {
  const api = useApi();
  const act = useAction();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("search");
  const [engine, setEngine] = useState<SearchEngine>("brave");
  const [focused, setFocused] = useState(true);
  const deleting = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const composer = useComposer();
  const sug = useAddressSuggest(text, mode === "search" && engine === "brave", deleting.current);
  const picked = sug.selected >= 0 ? sug.matches[sug.selected] : undefined;
  const shown = picked ? fillOf(picked) : text + sug.inline;
  const open = focused && sug.matches.length > 0;

  // The inline completion is selected, so typing on replaces it, as in the address bar.
  useLayoutEffect(() => {
    const input = field.current;
    if (input && !picked && sug.inline && document.activeElement === input) input.setSelectionRange(text.length, shown.length);
  }, [shown]);

  const submit = (asMode: Mode) => {
    const clean = text.trim();
    if (clean) onSubmit({ text: clean, mode: asMode, engine: asMode === "ask" ? "brave" : engine });
  };
  const openMatch = (m: AddressMatch) => void act(() => api.openAddress(m.url));

  const onKeyDown = (e: KeyboardEvent) => {
    const input = e.currentTarget as HTMLInputElement;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      sug.select(sug.selected + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey || mode === "ask") return submit("ask");
      if (picked) return openMatch(picked);
      if (sug.inline && sug.matches[0]) return openMatch(sug.matches[0]);
      submit("search");
    } else if ((e.key === "ArrowRight" || e.key === "End") && sug.inline && !picked) {
      // Accepting the completion makes it typed text.
      setText(text + sug.inline);
      sug.dropInline();
    } else if (e.key === "Tab" && !e.shiftKey && mode === "search" && text.trim()) {
      e.preventDefault();
      setEngine((x) => (x === "google" ? "brave" : "google"));
    } else if (e.key === "Backspace" && engine === "google" && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      setEngine("brave");
    } else if (e.key === "Backspace" && sug.inline && !picked) {
      // The first Backspace removes the completion only.
      e.preventDefault();
      deleting.current = true;
      sug.dropInline();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      sug.clear();
    } else if (e.key === "Escape" && text) {
      e.preventDefault();
      setText("");
      setEngine("brave");
    }
  };

  return (
    <div class="addr">
      <div class="box">
        <div class="box-row">
          <Icon of={Search} />
          {engine === "google" && mode === "search" && <span class="engine-chip">Google</span>}
          <input
            ref={field}
            type="search"
            role="combobox"
            aria-label="Search or ask"
            aria-describedby="addr-hints"
            aria-expanded={open}
            aria-controls="addr-suggest"
            aria-autocomplete="both"
            aria-activedescendant={picked ? `addr-s-${sug.selected}` : undefined}
            placeholder={mode === "ask" ? "Ask Perch a task" : "Search or type a site"}
            value={shown}
            autoFocus
            spellcheck={false}
            autoComplete="off"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onInput={(e) => {
              deleting.current = /^delete/.test((e as InputEvent).inputType ?? "");
              const value = (e.currentTarget as HTMLInputElement).value;
              sug.select(-1);
              setText(value);
            }}
            onKeyDown={onKeyDown}
          />
          <Segmented class="mode" label="Search or ask" value={mode} onChange={setMode} options={[{ value: "search", label: "Search" }, { value: "ask", label: "Ask" }]} />
        </div>
        <div class="box-foot">
          <Composer side="mode" composer={composer} />
          <Composer side="model" composer={composer} />
        </div>
        {open && (
          <ul class="addr-suggest" id="addr-suggest" role="listbox" aria-label="Suggestions">
            {sug.matches.map((m, i) => (
              <li
                key={`${m.url}-${i}`}
                id={`addr-s-${i}`}
                role="option"
                aria-selected={i === sug.selected}
                class={i === sug.selected ? "on" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => sug.select(i)}
                onClick={() => openMatch(m)}
              >
                <Icon of={m.kind === "search" ? Search : Globe} />
                <span class="s-main">{m.contents}</span>
                {m.description && <span class="s-desc">{m.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p class="hints" id="addr-hints">
        <kbd class="key">Tab</kbd> <span>Google</span> <span aria-hidden="true">·</span> <kbd class="key" aria-label="Command Return">⌘↵</kbd> <span>Ask</span>
      </p>
    </div>
  );
}

/** What the field shows for a picked suggestion: a site's address without its scheme, or the search. */
function fillOf(m: AddressMatch): string {
  return m.kind === "url" ? m.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : m.contents;
}

const MODE_NAMES: Readonly<Record<PermissionMode, string>> = { ask: "Ask before actions", guard: "Ask before sends", skip: "Skip confirmation" };

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
  const openSettings = () => void act(() => api.openPage("settings", "models"));
  return { c: state.data, save, openSettings };
}

function Composer({ side, composer }: { readonly side: "mode" | "model"; readonly composer: ReturnType<typeof useComposer> }) {
  const { c, save, openSettings } = composer;
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
  const model = c.models.find((m) => m.id === c.model);
  const efforts = model?.efforts ?? [];
  return (
    <span class="composer-model">
      <ModelMenu models={c.models} selected={c.model} onPick={(m) => void save({ model: m.id })} onSettings={openSettings}>
        {model && <ProviderGlyph provider={model.provider} size={12} />}
        <span class="mm-t">{model ? modelName(model.label) : "Pick a model"}</span>
      </ModelMenu>
      {efforts.length > 0 && (
        <select class="picker quiet" aria-label="Effort" value={c.effort} onChange={(e) => void save({ effort: e.currentTarget.value as ChatEffort })}>
          {efforts.map((x) => <option key={x} value={x}>{EFFORT_NAMES[x]}</option>)}
        </select>
      )}
    </span>
  );
}
