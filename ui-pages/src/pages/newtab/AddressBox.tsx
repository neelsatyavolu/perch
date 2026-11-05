import { useState } from "preact/hooks";
import type { Query, SearchEngine } from "../../api";
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
      <p class="hints" id="addr-hints">
        <kbd class="key">Tab</kbd> <span>Google</span> <span aria-hidden="true">·</span> <kbd class="key" aria-label="Command Return">⌘↵</kbd> <span>Ask</span>
      </p>
    </div>
  );
}
