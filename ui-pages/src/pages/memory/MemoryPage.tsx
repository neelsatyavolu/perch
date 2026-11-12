import { useEffect, useState } from "preact/hooks";
import type { MemoryDoc, MemoryFolder, MemoryPage as Page } from "../../api";
import { inlineTime } from "../../lib/time";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { ArrowLeft, Icon, Search, User } from "../../ui/icons";
import { Switch } from "../../ui/Switch";
import { SetupMemory } from "./SetupMemory";
import "./memory.css";

const FOLDERS: readonly { id: MemoryFolder; label: string }[] = [
  { id: "", label: "Core" }, { id: "users", label: "You" }, { id: "people", label: "People" }, { id: "companies", label: "Companies" },
  { id: "sites", label: "Sites" }, { id: "projects", label: "Projects" }, { id: "routines", label: "Routines" },
  { id: "concepts", label: "Concepts" }, { id: "episodic", label: "Daily notes" },
];

function Editor({ path, onDeleted }: { readonly path: string; readonly onDeleted: (path: string) => void }) {
  const api = useApi();
  const act = useAction();
  const doc = useLoad((a) => a.readMemoryPage(path), [path]);
  const [body, setBody] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setBody(null), [path]);
  const d: MemoryDoc | undefined = doc.data;
  if (!d) return <div class="mem-doc"><p class="mute">{doc.error ?? ""}</p></div>;
  const value = body ?? d.body;
  const dirty = body !== null && body !== d.body;
  return (
    <section class="mem-doc" aria-labelledby="doc-h">
      <div class="doc-h">
        <div>
          <h2 id="doc-h">{d.title}</h2>
          <p class="cap"><span class="mono">{d.path}</span> · updated {inlineTime(d.updatedAt)}</p>
        </div>
        <span class="grow" />
        <button type="button" class="btn danger" onClick={() => setConfirming(true)}>Delete page</button>
        <button type="button" class="btn primary" disabled={!dirty} onClick={async () => {
          const saved = await act(() => api.writeMemoryPage(d.path, value), `Saved ${d.title}`);
          if (saved) {
            doc.set(saved);
            setBody(null);
          }
        }}>Save</button>
      </div>
      <textarea class="field doc-body mono" aria-label={d.title} spellcheck={false} value={value} onInput={(e) => setBody((e.currentTarget as HTMLTextAreaElement).value)} />
      <Dialog open={confirming} title={`Delete ${d.title}?`} onClose={() => setConfirming(false)} footer={<>
        <button type="button" class="btn" onClick={() => setConfirming(false)}>Cancel</button>
        <button type="button" class="btn primary danger" onClick={async () => {
          setConfirming(false);
          if (await act(() => api.deleteMemoryPage(d.path).then(() => true), `Deleted ${d.title}`)) onDeleted(d.path);
        }}>Delete page</button>
      </>}>
        <p>Perch will forget what this page says. This can't be undone.</p>
      </Dialog>
    </section>
  );
}

function Browser({ onSetup }: { readonly onSetup: () => void }) {
  const api = useApi();
  const act = useAction();
  const pages = useLoad((a) => a.listMemoryPages());
  const settings = useLoad((a) => a.getMemorySettings());
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const all: readonly Page[] = pages.data ?? [];
  const q = filter.trim().toLowerCase();
  const shown = q ? all.filter((p) => `${p.title} ${p.path}`.toLowerCase().includes(q)) : all;

  return (
    <div class="mem-browse">
      <div class="mem-top">
        <h1 tabIndex={-1}>Memory</h1>
        <span class="grow" />
        {settings.data && (
          <label class="check">
            <span class="cap">Learn from chats</span>
            <Switch label="Learn from chats" checked={settings.data.extraction} onChange={async (extraction) => {
              const next = await act(() => api.setMemorySettings({ extraction }), extraction ? "Perch is learning from chats again" : "Paused. Perch won't learn from new chats.");
              if (next) settings.set(next);
            }} />
          </label>
        )}
        <button type="button" class="btn" onClick={onSetup}><Icon of={User} />Set up your memory</button>
      </div>
      {pages.data && all.length === 0 ? (
        <div class="mem-empty">
          <h2 class="serif-title">Nothing in memory yet</h2>
          <p class="mute">Perch saves lasting facts from your chats here, or you can build a profile now from sources you choose.</p>
          <button type="button" class="btn primary" onClick={onSetup}>Set up your memory</button>
        </div>
      ) : (
        <div class="mem-split">
          <nav class="mem-list" aria-label="Memory pages">
            <div class="snav-search">
              <Icon of={Search} size={14} />
              <input type="search" aria-label="Filter memory" placeholder="Filter" value={filter} onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)} />
            </div>
            {FOLDERS.map((f) => {
              const items = shown.filter((p) => p.folder === f.id);
              if (!items.length) return null;
              return (
                <section key={f.id || "core"} aria-labelledby={`mf-${f.id || "core"}`}>
                  <h3 class="rail-lbl" id={`mf-${f.id || "core"}`}>{f.label}</h3>
                  {items.map((p) => (
                    <button key={p.path} type="button" class="row" aria-current={p.path === selected ? "page" : undefined} onClick={() => setSelected(p.path)}>
                      {p.title}
                    </button>
                  ))}
                </section>
              );
            })}
            {shown.length === 0 && <p class="rail-empty">No pages match</p>}
          </nav>
          {selected ? (
            <Editor key={selected} path={selected} onDeleted={(path) => {
              setSelected(null);
              pages.set(all.filter((p) => p.path !== path));
            }} />
          ) : (
            <div class="mem-doc mem-pick"><p class="mute">Pick a page to read or edit it. Memory is plain markdown, encrypted on this Mac.</p></div>
          )}
        </div>
      )}
    </div>
  );
}

const viewFromHash = () => (window.location.hash.startsWith("#setup") ? "setup" : "browse");

/** perch://memory: browse and edit memory, and the "Set up your memory" flow at #setup. */
export function MemoryPage() {
  const [view, setView] = useState<"browse" | "setup">(viewFromHash);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (v: "browse" | "setup") => {
    history.replaceState(null, "", v === "setup" ? "#setup" : "#");
    setView(v);
    requestAnimationFrame(() => document.querySelector<HTMLElement>("h1")?.focus());
  };
  return (
    <main class="mem-page">
      {view === "setup" ? (
        <>
          <div class="mem-back"><button type="button" class="btn quiet back" onClick={() => go("browse")}><Icon of={ArrowLeft} />Memory</button></div>
          <SetupMemory onOpenMemory={() => go("browse")} />
        </>
      ) : (
        <Browser onSetup={() => go("setup")} />
      )}
    </main>
  );
}
