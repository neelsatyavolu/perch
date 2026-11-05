/**
 * Perch's UI inside web pages: a closed shadow root on a custom element, so the page's CSS cannot
 * restyle it and the page's scripts cannot read it. Colours follow DESIGN.md (Ink dark, Paper light).
 */

export const TOKENS = `
:host { all: initial; }
.perch {
  --canvas: #000000; --card: #0E0E10; --elevated: #1A1A1E; --ink: #FCFDFF; --body: rgb(252 253 255 / 0.86);
  --mute: #A1A4A5; --hairline: rgb(255 255 255 / 0.06); --hairline-strong: rgb(255 255 255 / 0.14);
  --accent: #4C8DFF; --btn-fg: #000000; --btn-bg: #FCFDFF;
  --shadow: 0 8px 28px rgb(0 0 0 / 0.45);
  --sans: "Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  --serif: "Geist Serif", "New York", ui-serif, Georgia, serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --ease: cubic-bezier(0.2, 0, 0, 1);
  font: 13px/1.45 var(--sans); color: var(--body); -webkit-font-smoothing: antialiased; letter-spacing: 0;
}
@media (prefers-color-scheme: light) {
  .perch {
    --canvas: #F4F5F7; --card: #FFFFFF; --elevated: #ECEEF1; --ink: #0A0A0C; --body: rgb(10 10 12 / 0.82);
    --mute: #5F6366; --hairline: rgb(0 0 0 / 0.06); --hairline-strong: rgb(0 0 0 / 0.12);
    --accent: #2B68D6; --btn-fg: #FFFFFF; --btn-bg: #0A0A0C; --shadow: 0 8px 28px rgb(0 0 0 / 0.14);
  }
}
.perch * { box-sizing: border-box; }
.perch button { font: 500 13px/1 var(--sans); color: var(--ink); background: var(--elevated); border: 1px solid var(--hairline-strong);
  border-radius: 8px; height: 28px; padding: 0 12px; cursor: pointer; transition: background-color 120ms var(--ease); }
.perch button:hover { background: var(--hairline-strong); }
.perch button.primary { background: var(--btn-bg); color: var(--btn-fg); border-color: transparent; }
.perch button:focus-visible, .perch a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .perch * { transition: none !important; animation: none !important; } }
`;

export type Overlay = { host: HTMLElement; root: ShadowRoot; remove: () => void };

export function createOverlay(tag: string, css: string): Overlay {
  const host = document.createElement(tag);
  host.setAttribute("style", "all: initial; position: fixed; inset: auto; z-index: 2147483647;");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = TOKENS + css;
  root.append(style);
  document.documentElement.append(host);
  return { host, root, remove: () => host.remove() };
}

/** Builds an element with text only: page-supplied strings never go through innerHTML here. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export function isEditable(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file", "image"].includes(target.type);
  return false;
}
