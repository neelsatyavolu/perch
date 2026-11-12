/**
 * Perch's UI inside web pages: a closed shadow root on a custom element, so the page's CSS cannot
 * restyle it and the page's scripts cannot read it. Colours follow DESIGN.md (Ink dark, Paper light).
 */

export const TOKENS = `
:host { all: initial; }
.perch {
  --canvas: #0E0E0D; --card: #141413; --elevated: #1A1A18; --ink: #F2F0EA; --body: rgb(242 240 234 / 0.86);
  --mute: #8B8A87; --hairline: rgb(242 240 234 / 0.08); --hairline-strong: rgb(242 240 234 / 0.18);
  --accent: #4C8DFF; --btn-fg: #0E0E0D; --btn-bg: #F2F0EA;
  --sans: "Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  --serif: "Newsreader", Georgia, serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --ease: cubic-bezier(0.2, 0, 0, 1);
  font: 13px/20px var(--sans); color: var(--body); -webkit-font-smoothing: antialiased; letter-spacing: 0;
}
@media (prefers-color-scheme: light) {
  .perch {
    --canvas: #F7F5EF; --card: #FBFAF6; --elevated: #EFECE4; --ink: #16161A; --body: rgb(22 22 26 / 0.86);
    --mute: #676667; --hairline: rgb(22 22 26 / 0.1); --hairline-strong: rgb(22 22 26 / 0.22);
    --accent: #2A63CC; --btn-fg: #F7F5EF; --btn-bg: #16161A;
  }
}
.perch * { box-sizing: border-box; }
.perch button { font: 500 13px/1 var(--sans); color: var(--ink); background: var(--elevated); border: 1px solid var(--hairline-strong);
  border-radius: 8px; height: 28px; padding: 0 12px; cursor: default; transition: background-color 120ms var(--ease); }
.perch button:hover { background: color-mix(in srgb, var(--ink) 6%, var(--elevated)); }
.perch button.primary { background: var(--btn-bg); color: var(--btn-fg); border-color: transparent; }
.perch button.primary:hover { background: color-mix(in srgb, var(--btn-fg) 12%, var(--btn-bg)); }
/* Floating overlays are glass, not shadowed: a blurred backdrop under a tint, with a hairline edge. The page
   underneath can be any colour (a dark card over a white page), so the tint is dense enough and secondary
   text a step brighter that every line keeps 4.5:1 over the worst backdrop. */
.perch.glass { background: color-mix(in srgb, var(--elevated) 84%, transparent); -webkit-backdrop-filter: blur(28px) saturate(1.5);
  backdrop-filter: blur(28px) saturate(1.5); border: 1px solid var(--hairline-strong);
  --mute: color-mix(in srgb, var(--ink) 72%, var(--elevated)); }
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
