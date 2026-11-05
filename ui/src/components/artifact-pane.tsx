/**
 * The artifact pane (spec 7.7): the selected artifact with its versions. Pages and drawings load
 * from the isolated artifact origin in a sandboxed frame; documents, code and data render here.
 * The pane is 360px by default and resizable with the pointer or the arrow keys.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { Client } from "../api/client";
import type { ArtifactMeta } from "../api/types";
import { Icon } from "./icon";
import { Markdown } from "./markdown";

export const PANE = { min: 280, max: 720, initial: 360, step: 16 };
const EXT: Record<ArtifactMeta["kind"], string> = { html: "html", markdown: "md", code: "txt", svg: "svg", csv: "csv", json: "json", image: "png" };

export function clampWidth(width: number): number {
  return Math.round(Math.min(PANE.max, Math.max(PANE.min, width)));
}

/** Splits CSV text into rows, honouring quoted fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

function Body({ meta, content }: { meta: ArtifactMeta; content: string | null }) {
  if (meta.kind === "html" || meta.kind === "svg") {
    return <iframe class="art-frame" title={meta.title} src={meta.url} sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" />;
  }
  if (meta.kind === "image") return <img class="art-img" src={meta.url} alt={meta.title} />;
  if (content === null) return <p class="cap">Loading</p>;
  if (meta.kind === "markdown") return <Markdown text={content} />;
  if (meta.kind === "csv") {
    const [head, ...rows] = parseCsv(content);
    return (
      <div class="md-table">
        <table>
          <thead>
            <tr>{head?.map((c, i) => <th key={i}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <pre class="art-code">
      <code>{content}</code>
    </pre>
  );
}

type PaneProps = { client: Client; meta: ArtifactMeta; width: number; onWidth: (w: number) => void; onClose: () => void };

export function ArtifactPane({ client, meta, width, onWidth, onClose }: PaneProps) {
  const [version, setVersion] = useState(meta.versions);
  const [shown, setShown] = useState<{ meta: ArtifactMeta; content: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => setVersion(meta.versions), [meta.id, meta.versions]);
  useEffect(() => {
    let live = true;
    setError(null);
    client
      .artifact(meta.id, version)
      .then((r) => live && setShown(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [meta.id, version, meta.versions]);

  const download = () => {
    if (!shown) return;
    const blob = shown.content === null ? null : new Blob([shown.content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = blob ? URL.createObjectURL(blob) : shown.meta.url;
    a.download = `${meta.title.replace(/[^\w .-]/g, "_")}.${meta.kind === "code" ? meta.language ?? "txt" : EXT[meta.kind]}`;
    a.click();
    if (blob) setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <aside class="art" style={{ width: `${width}px` }} aria-label="Artifact">
      <div
        class="resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the artifact pane"
        aria-valuenow={width}
        aria-valuemin={PANE.min}
        aria-valuemax={PANE.max}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") onWidth(clampWidth(width + PANE.step));
          else if (e.key === "ArrowRight") onWidth(clampWidth(width - PANE.step));
          else return;
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => drag.current && onWidth(clampWidth(drag.current.w + drag.current.x - e.clientX))}
        onPointerUp={() => (drag.current = null)}
      />
      <div class="art-h">
        <span class="title">{meta.title}</span>
        {meta.versions > 1 ? (
          <select class="ver mono" aria-label="Version" value={version} onChange={(e) => setVersion(Number((e.target as HTMLSelectElement).value))}>
            {Array.from({ length: meta.versions }, (_, i) => (
              <option key={i} value={i + 1}>
                v{i + 1}
              </option>
            ))}
          </select>
        ) : (
          <span class="mono ver">v1</span>
        )}
        <a class="ib" href={shown?.meta.url ?? meta.url} target="_blank" rel="noopener noreferrer" aria-label="Open as a tab" title="Open as a tab">
          <Icon name="external" />
        </a>
        <button type="button" class="ib" aria-label="Save to disk" title="Save to disk" onClick={download}>
          <Icon name="download" />
        </button>
        <button type="button" class="ib" aria-label="Close artifact" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div class="art-b">{error ? <p class="note error">{error}</p> : shown ? <Body meta={shown.meta} content={shown.content} /> : <p class="cap">Loading</p>}</div>
    </aside>
  );
}
