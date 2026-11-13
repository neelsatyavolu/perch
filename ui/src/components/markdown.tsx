/**
 * A small Markdown renderer for chat replies (spec 7.6). It builds elements, never HTML strings,
 * so a reply can never inject markup. Unfinished input renders as it stands, which keeps
 * streaming text steady: an open code fence is a code block until it closes.
 */

import type { ComponentChildren, VNode } from "preact";
import { memo } from "./memo";

export type MarkdownProps = { text: string; renderArtifact?: (id: string) => VNode | null };

const SAFE_URL = /^(https?:|mailto:)/i;
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const MARKER = /^\[\[artifact:([\w-]{1,64})\]\]$/;

/** Memoized: parsing runs again only when the text or the artifact renderer changes. */
export const Markdown = memo(function Markdown({ text, renderArtifact }: MarkdownProps) {
  return <div class="md">{blocks(text.replace(/\r\n?/g, "\n").split("\n"), renderArtifact)}</div>;
});

function blocks(lines: string[], renderArtifact: MarkdownProps["renderArtifact"]): VNode[] {
  const out: VNode[] = [];
  let i = 0;
  const key = () => out.length;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(FENCE);
    if (fence) {
      const close = lines.findIndex((l, j) => j > i && l.trim() === fence[2]);
      const end = close < 0 ? lines.length : close;
      const info = fence[3]!.trim();
      const body = lines.slice(i + 1, end).join("\n");
      out.push(info.startsWith("artifact") ? <PendingArtifact key={key()} info={info} /> : <CodeBlock key={key()} language={info.split(/\s+/)[0] ?? ""} code={body} />);
      i = end + 1;
      continue;
    }
    const marker = line.trim().match(MARKER);
    if (marker) {
      const node = renderArtifact?.(marker[1]!);
      if (node) out.push(<div key={key()}>{node}</div>);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6);
      const H = `h${level}` as "h3";
      out.push(<H key={key()}>{inline(heading[2]!)}</H>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (isTable(lines, i)) {
      const rows: string[][] = [];
      let j = i;
      while (j < lines.length && lines[j]!.includes("|")) {
        if (j !== i + 1) rows.push(cells(lines[j]!));
        j++;
      }
      out.push(<Table key={key()} rows={rows} />);
      i = j;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key()}>{blocks(quoted, renderArtifact)}</blockquote>);
      continue;
    }
    const item = line.match(/^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/);
    if (item) {
      const ordered = /\d/.test(item[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/);
        if (m && /\d/.test(m[1]!) === ordered) items.push(m[2]!);
        else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) items[items.length - 1] += ` ${lines[i]!.trim()}`;
        else break;
        i++;
      }
      const List = ordered ? "ol" : "ul";
      out.push(<List key={key()}>{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</List>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !/^(#{1,6})\s/.test(lines[i]!) && !MARKER.test(lines[i]!.trim()) && !/^\s*([-*+]|\d{1,9}[.)])\s+/.test(lines[i]!) && !/^\s*>/.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    if (!para.length) para.push(lines[i++]!);
    out.push(<p key={key()}>{inline(para.join("\n"))}</p>);
  }
  return out;
}

function isTable(lines: string[], i: number): boolean {
  return Boolean(lines[i]?.includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? ""));
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Cells this short (dates, names, amounts) stay on one line; longer ones wrap between words. */
const SHORT_CELL = 24;

function cellClass(text: string): string | undefined {
  return text.length <= SHORT_CELL ? "short" : undefined;
}

function Table({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  return (
    <div class="md-table">
      <table>
        <thead>
          <tr>{head?.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, n) => (
            <tr key={n}>{r.map((c, m) => <td key={m} class={cellClass(c)}>{inline(c)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <figure class="code">
      <figcaption>
        <span class="mono">{language || "text"}</span>
        <button type="button" class="link-btn" onClick={() => void navigator.clipboard?.writeText(code)}>
          Copy
        </button>
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function PendingArtifact({ info }: { info: string }) {
  const title = info.match(/"([^"]+)"/)?.[1] ?? "an artifact";
  return <div class="artifact-card pending">Making {title}</div>;
}

const INLINE = /(`+)([^`]+?)\1|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|(?<![\w])_([^_\s][^_\n]*?)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Code, bold, italic, links and bare web addresses. Anything else is plain text. */
export function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const key = out.length;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key}>{inline(m[3] ?? m[4]!)}</strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={key}>{inline(m[5] ?? m[6]!)}</em>);
    else if (m[7] !== undefined) out.push(SAFE_URL.test(m[8]!) ? <Link key={key} href={m[8]!}>{inline(m[7])}</Link> : m[0]);
    else if (m[9] !== undefined) out.push(<Link key={key} href={m[9]}>{m[9]}</Link>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Link({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
