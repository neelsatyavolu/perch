/**
 * Files the agent made (artifacts) as files: the card under a reply with a Download button, the
 * Outputs panel of the full-page chat, and the right-click menu both share (Open, Download, Show
 * in Finder, Copy contents, Rename, Delete). Downloads go through perchd to the Downloads folder,
 * so Show in Finder can point at the same file.
 */

import { render, type ComponentChildren, type VNode } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Client } from "../api/client";
import type { ArtifactMeta } from "../api/types";
import { Icon } from "./icon";

const EXT: Record<ArtifactMeta["kind"], string> = { html: "html", markdown: "md", code: "txt", svg: "svg", csv: "csv", json: "json", image: "png" };

export function fileExtension(meta: ArtifactMeta): string {
  return meta.kind === "code" && meta.language && /^\w{1,16}$/.test(meta.language) ? meta.language : EXT[meta.kind];
}

/** The file's name as Downloads gets it: the title, safe for Finder, with its extension. */
export function fileName(meta: ArtifactMeta): string {
  const ext = fileExtension(meta);
  const stem = meta.title.replace(/[/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "artifact";
  return stem.toLowerCase().endsWith(`.${ext}`) ? stem : `${stem}.${ext}`;
}

/** The title to keep when the user types a file name: the extension it already has is dropped. */
function titleFrom(name: string, meta: ArtifactMeta): string {
  const ext = `.${fileExtension(meta)}`;
  const trimmed = name.trim();
  return trimmed.toLowerCase().endsWith(ext) && trimmed.length > ext.length ? trimmed.slice(0, -ext.length) : trimmed;
}

/** Readable text for the thumbnail: a page's words rather than its markup. */
export function previewText(meta: ArtifactMeta, content: string): string {
  const text = meta.kind === "html" || meta.kind === "svg" ? content.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ") : content;
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 600);
}

const previews = new Map<string, Promise<string>>();

function usePreview(client: Client, meta: ArtifactMeta): string {
  const [text, setText] = useState("");
  useEffect(() => {
    if (meta.kind === "image") return;
    const key = `${meta.id}:${meta.versions}`;
    let p = previews.get(key);
    if (!p) {
      p = client.artifact(meta.id).then((r) => previewText(meta, r.content ?? ""), () => "");
      previews.set(key, p);
    }
    let live = true;
    void p.then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [meta.id, meta.versions]);
  return text;
}

/** A small page with the file's first lines on it, as Finder would show. */
export function FileThumb({ client, meta, large = false }: { client: Client; meta: ArtifactMeta; large?: boolean }) {
  const text = usePreview(client, meta);
  return (
    <span class={large ? "thumb large" : "thumb"} aria-hidden="true">
      {meta.kind === "image" ? <img src={meta.url} alt="" /> : <span class="thumb-text">{text}</span>}
      <span class="thumb-ext">{fileExtension(meta).toUpperCase()}</span>
    </span>
  );
}

type Actions = {
  open: () => void;
  download: () => Promise<void>;
  reveal: () => Promise<void>;
  copy: () => Promise<void>;
  rename: (name: string) => Promise<void>;
  remove: () => Promise<void>;
};

/** What each file surface can do, with a short-lived note ("Saved to Downloads") or error. */
function useFileActions(client: Client, meta: ArtifactMeta, onOpen: (meta: ArtifactMeta) => void) {
  const [saved, setSaved] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => setSaved(null), [meta.versions, meta.title]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);
  const attempt = (what: string, fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      setNote({ text: `Could not ${what}: ${e instanceof Error ? e.message : String(e)}`, error: true });
    }
  };
  const actions: Actions = {
    open: () => onOpen(meta),
    download: attempt("download it", async () => {
      const { path } = await client.downloadArtifact(meta.id);
      setSaved(path);
      setNote({ text: "Saved to Downloads" });
    }),
    reveal: attempt("show it in Finder", async () => {
      const { path } = await client.downloadArtifact(meta.id, true);
      setSaved(path);
    }),
    copy: attempt("copy it", async () => {
      const { content } = await client.artifact(meta.id);
      await navigator.clipboard.writeText(content ?? "");
      setNote({ text: "Copied" });
    }),
    rename: async (name: string) => {
      const title = titleFrom(name, meta);
      if (title && title !== meta.title) await attempt("rename it", async () => void (await client.renameArtifact(meta.id, title)))();
    },
    remove: attempt("delete it", async () => void (await client.deleteArtifact(meta.id))),
  };
  return { actions, saved, note };
}

type MenuItem = { label: string; run: () => void; danger?: boolean; confirm?: string };

/**
 * Renders its children at the end of the page body: a menu inside a blurred panel would otherwise
 * be placed against that panel (backdrop-filter makes it the containing block) rather than the window.
 */
function Portal({ children }: { children: ComponentChildren }) {
  const host = useRef<HTMLDivElement | null>(null);
  if (!host.current) host.current = document.createElement("div");
  useLayoutEffect(() => {
    const el = host.current!;
    document.body.append(el);
    return () => {
      render(null, el);
      el.remove();
    };
  }, []);
  useLayoutEffect(() => render(<>{children}</>, host.current!));
  return null;
}

/** The right-click menu: at the pointer, kept on screen, arrow keys move, Escape closes. */
function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [active, setActive] = useState(0);
  const [confirming, setConfirming] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
    el.focus({ preventScroll: true });
    const away = (e: PointerEvent) => !el.contains(e.target as Node) && onClose();
    const blur = () => onClose();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
    };
  }, []);
  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    // A destructive item asks once more in place instead of acting on the first click.
    if (item.confirm && confirming !== i) return setConfirming(i);
    onClose();
    item.run();
  };
  return (
    <div
      ref={ref}
      class="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") onClose();
        else if (e.key === "ArrowDown") setActive((i) => (i + 1) % items.length);
        else if (e.key === "ArrowUp") setActive((i) => (i - 1 + items.length) % items.length);
        else if (e.key === "Enter" || e.key === " ") choose(active);
        else return;
        e.preventDefault();
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          class={[i === active && "on", item.danger && "danger", i > 0 && items[i - 1]!.danger !== item.danger && "sep"].filter(Boolean).join(" ")}
          onPointerEnter={() => setActive(i)}
          onClick={() => choose(i)}
        >
          {confirming === i && item.confirm ? item.confirm : item.label}
        </button>
      ))}
    </div>
  );
}

function menuItems(meta: ArtifactMeta, a: Actions, startRename: () => void): MenuItem[] {
  return [
    { label: "Open", run: a.open },
    { label: "Download", run: () => void a.download() },
    { label: "Show in Finder", run: () => void a.reveal() },
    ...(meta.kind === "image" ? [] : [{ label: "Copy contents", run: () => void a.copy() }]),
    { label: "Rename", run: startRename },
    { label: "Delete", run: () => void a.remove(), danger: true, confirm: "Delete this file?" },
  ];
}

/** Right-click and rename state for one file surface. */
function useFileSurface(client: Client, meta: ArtifactMeta, onOpen: (meta: ArtifactMeta) => void) {
  const { actions, saved, note } = useFileActions(client, meta, onOpen);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  /** Enter and leaving the field both commit; whichever comes first wins. */
  const done = useRef(false);
  const commit = (value: string) => {
    if (done.current) return;
    done.current = true;
    setRenaming(false);
    void actions.rename(value);
  };
  const startRename = () => {
    done.current = false;
    setRenaming(true);
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };
  const menu = menuAt ? (
    <Portal>
      <ContextMenu at={menuAt} items={menuItems(meta, actions, startRename)} onClose={() => setMenuAt(null)} />
    </Portal>
  ) : null;
  const name: VNode = renaming ? (
    <input
      class="file-rename"
      aria-label="File name"
      value={fileName(meta)}
      autoFocus
      onFocus={(e) => {
        const input = e.currentTarget;
        input.setSelectionRange(0, Math.max(0, input.value.lastIndexOf(".")) || input.value.length);
      }}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "Escape") {
          done.current = true;
          setRenaming(false);
        }
      }}
    />
  ) : (
    <span class="t" title={fileName(meta)}>
      {fileName(meta)}
    </span>
  );
  return { actions, saved, note, onContextMenu, menu, name, renaming };
}

type FileProps = { client: Client; meta: ArtifactMeta; onOpen: (meta: ArtifactMeta) => void; selected?: boolean };

/** Under a reply: "Created file", its name, and Download (then Show in Finder). */
export function FileCard({ client, meta, onOpen, selected }: FileProps) {
  const { actions, saved, note, onContextMenu, menu, name, renaming } = useFileSurface(client, meta, onOpen);
  return (
    <div class={selected ? "file-card sel" : "file-card"} onContextMenu={onContextMenu}>
      <button type="button" class="file-open" aria-label={`Open ${fileName(meta)}`} title="Open" disabled={renaming} onClick={actions.open}>
        <FileThumb client={client} meta={meta} />
      </button>
      <span class="file-text" onDblClick={actions.open}>
        <span class="k">{note ? <span class={note.error ? "err" : undefined}>{note.text}</span> : meta.versions > 1 ? `Updated file · version ${meta.versions}` : "Created file"}</span>
        {name}
      </span>
      {saved ? (
        <button type="button" class="btn small outline" title={saved} onClick={() => void actions.reveal()}>
          <Icon name="folder" />
          Show in Finder
        </button>
      ) : (
        <button type="button" class="btn small outline" onClick={() => void actions.download()}>
          <Icon name="download" />
          Download
        </button>
      )}
      {menu}
    </div>
  );
}

/** One file in the Outputs panel. */
function OutputTile({ client, meta, onOpen, selected }: FileProps) {
  const { actions, note, onContextMenu, menu, name } = useFileSurface(client, meta, onOpen);
  return (
    <li class={selected ? "tile sel" : "tile"} onContextMenu={onContextMenu}>
      <button type="button" class="tile-open" aria-label={`Open ${fileName(meta)}`} title={`${fileName(meta)} — right-click for more`} onClick={actions.open}>
        <FileThumb client={client} meta={meta} large />
      </button>
      {name}
      {note && <span class={note.error ? "tile-note err" : "tile-note"}>{note.text}</span>}
      {menu}
    </li>
  );
}

/** The full-page chat's Outputs: every file this chat made, newest first. */
export function OutputsPanel({ client, artifacts, selected, onOpen, onClose }: { client: Client; artifacts: ArtifactMeta[]; selected: string | null; onOpen: (meta: ArtifactMeta) => void; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".ctx-menu") && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const newest = [...artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <section ref={ref} class="outputs" aria-label="Outputs">
      <header>
        <span>Outputs</span>
        <button type="button" class="ib" aria-label="Close outputs" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      {newest.length ? (
        <ul>
          {newest.map((m) => (
            <OutputTile key={m.id} client={client} meta={m} onOpen={onOpen} selected={selected === m.id} />
          ))}
        </ul>
      ) : (
        <p class="cap">Files Perch makes in this chat show here.</p>
      )}
    </section>
  );
}
