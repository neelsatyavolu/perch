import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CommandBarResult } from "../../api";
import { errorText, useAction, useAnnounce, useApi } from "../../ui/frame";
import { Icon, Search } from "../../ui/icons";
import { matchCommands } from "./commands";
import { type Entry, GROUP_ORDER, buildEntries } from "./entries";
import "./command-bar.css";

/** Wait this long after the last keystroke before asking the browser. */
export const QUERY_DEBOUNCE_MS = 80;
const PLACEHOLDER = "Search tabs, history, bookmarks and commands";
const optionId = (i: number) => `cb-opt-${i}`;

/**
 * The command bar (⌘K), shown by the browser at chrome://perch-command-bar in a 640px bubble.
 * Running an item is the page's last call: the browser closes the bubble itself.
 */
export function CommandBar() {
  const api = useApi();
  const act = useAction();
  const announce = useAnnounce();
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  /** Text typed whose results have not arrived yet; null when the results match the field. */
  const pending = useRef<string | null>(null);
  /** Enter was pressed while results were pending: run the first entry when they arrive. */
  const runOnArrive = useRef(false);
  const [text, setText] = useState("");
  const [results, setResults] = useState<readonly CommandBarResult[]>([]);
  const [sel, setSel] = useState(0);

  const query = (value: string) => {
    const n = ++latest.current;
    api.queryCommandBar(value).then(
      (r) => {
        if (n !== latest.current) return;
        pending.current = null;
        setResults(r);
        setSel(0);
        if (runOnArrive.current) {
          runOnArrive.current = false;
          run(buildEntries(r, matchCommands(value))[0]);
        }
      },
      (e) => {
        if (n !== latest.current) return;
        pending.current = null;
        runOnArrive.current = false;
        setResults([]);
        announce(errorText(e), "error");
      },
    );
  };

  useEffect(() => {
    // The browser shows the bubble when this first query arrives.
    query("");
    input.current?.focus();
    const refocus = () => input.current?.focus();
    window.addEventListener("focus", refocus);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener("focus", refocus);
    };
  }, []);

  const entries = useMemo(() => buildEntries(results, matchCommands(text)), [results, text]);

  useEffect(() => {
    document.getElementById(optionId(sel))?.scrollIntoView?.({ block: "nearest" });
  }, [sel, entries]);

  const onInput = (e: JSX.TargetedEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value;
    setText(value);
    setSel(0);
    latest.current++; // Any answer still in flight is now stale.
    pending.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      query(value);
    }, QUERY_DEBOUNCE_MS);
  };

  const run = (entry: Entry | undefined) => {
    if (entry) act(() => api.runCommandBarItem(entry.run));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const count = entries.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (count) setSel((s) => (s + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // The shown results are for older text: wait for this text's, asking now if not yet asked.
      if (pending.current !== null) {
        runOnArrive.current = true;
        if (timer.current !== undefined) {
          clearTimeout(timer.current);
          timer.current = undefined;
          query(pending.current);
        }
        return;
      }
      run(entries[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      act(() => api.closeCommandBar());
    }
  };

  const active = entries[sel] ? optionId(sel) : undefined;

  return (
    <main class="cb">
      <h1 class="sr-only">Command bar</h1>
      <div class="cb-field">
        <Icon of={Search} />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label={PLACEHOLDER}
          aria-expanded={entries.length > 0 ? "true" : "false"}
          aria-controls="cb-list"
          aria-autocomplete="list"
          aria-activedescendant={active}
          placeholder={PLACEHOLDER}
          autoComplete="off"
          spellcheck={false}
          value={text}
          onInput={onInput}
          onKeyDown={onKeyDown}
        />
      </div>
      {entries.length > 0 ? (
        <div id="cb-list" class="cb-list" role="listbox" aria-label="Results">
          {GROUP_ORDER.map((group) => {
            const rows = entries.map((entry, i) => ({ entry, i })).filter(({ entry }) => entry.group === group);
            if (!rows.length) return null;
            const labelId = `cb-group-${group.toLowerCase()}`;
            return (
              <div key={group} role="group" aria-labelledby={labelId} class="cb-group">
                <div id={labelId} class="cb-group-label" role="presentation">{group}</div>
                {rows.map(({ entry, i }) => (
                  <div
                    key={entry.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === sel ? "true" : "false"}
                    class="row cb-row"
                    onMouseMove={() => i !== sel && setSel(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(entry)}
                  >
                    <span class="cb-title">{entry.title}</span>
                    {entry.shortcut ? (
                      <span class="cb-keys" aria-label={`Shortcut ${entry.shortcut}`}>
                        {Array.from(entry.shortcut).map((k, n) => <kbd key={n} class="cb-key">{k}</kbd>)}
                      </span>
                    ) : entry.host ? (
                      <span class="cb-host">{entry.host}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <p id="cb-list" class="cb-none">No matches</p>
      )}
    </main>
  );
}
