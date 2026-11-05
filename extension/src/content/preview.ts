/**
 * Content script: hold Shift while pointing at a link to see a card with the page's title,
 * description and image, fetched without cookies by the service worker. "Open" opens it in a tab.
 */

import { createOverlay, el, isEditable, type Overlay } from "./overlay";

type Preview = { url: string; title: string | null; description: string | null; image: string | null; siteName: string; kind: "page" | "file" };
type Reply = { ok: true; value: Preview } | { ok: false; error: string };

const DELAY_MS = 300;
const CSS = `
.card { position: fixed; width: 360px; max-width: calc(100vw - 16px); background: var(--card); color: var(--body);
  border: 1px solid var(--hairline-strong); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
  opacity: 0; transform: translateY(4px); transition: opacity 180ms var(--ease), transform 180ms var(--ease); }
.card.shown { opacity: 1; transform: none; }
.image { display: block; width: 100%; aspect-ratio: 1.91 / 1; object-fit: cover; background: var(--elevated); border-bottom: 1px solid var(--hairline); }
.body { padding: 12px 16px 16px; display: grid; gap: 4px; }
.site { font: 12px/16px var(--mono); color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title { font: 500 14px/20px var(--sans); color: var(--ink); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.desc { font-size: 13px; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.url { font: 12px/16px var(--mono); color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 4px; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.note { color: var(--mute); }
`;

let hovered: HTMLAnchorElement | null = null;
let shiftDown = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let card: { overlay: Overlay; node: HTMLElement; link: HTMLAnchorElement } | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function linkFrom(event: Event): HTMLAnchorElement | null {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement && /^https?:/.test(node.href)) return node;
  }
  return null;
}

function schedule(): void {
  clearTimeout(timer);
  if (!hovered || !shiftDown || isEditable(document.activeElement)) return;
  if (card?.link === hovered) return;
  const link = hovered;
  timer = setTimeout(() => void show(link), DELAY_MS);
}

document.addEventListener(
  "mouseover",
  (event) => {
    const link = linkFrom(event);
    if (link) clearTimeout(closeTimer);
    if (link === hovered) return;
    hovered = link;
    shiftDown = (event as MouseEvent).shiftKey;
    schedule();
  },
  true,
);

document.addEventListener(
  "mouseout",
  (event) => {
    if (hovered && !hovered.contains((event as MouseEvent).relatedTarget as Node | null)) {
      hovered = null;
      clearTimeout(timer);
      if (card) closeTimer = setTimeout(close, 400);
    }
  },
  true,
);

window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape" && card) return close();
    if (event.key === "Shift" && !event.repeat) {
      shiftDown = true;
      schedule();
    }
  },
  true,
);
window.addEventListener("keyup", (event) => event.key === "Shift" && (shiftDown = false), true);
window.addEventListener("scroll", () => card && close(), { capture: true, passive: true });
window.addEventListener("pointerdown", (event) => card && !event.composedPath().includes(card.overlay.host) && close(), true);

async function show(link: HTMLAnchorElement): Promise<void> {
  close();
  const overlay = createOverlay("perch-link-preview", CSS);
  const node = el("div", { class: "perch card", attrs: { role: "dialog", "aria-label": "Link preview" } }, [
    el("div", { class: "body" }, [el("div", { class: "site", text: new URL(link.href).hostname }), el("div", { class: "note", text: "Loading preview" })]),
  ]);
  overlay.root.append(node);
  node.addEventListener("mouseenter", () => clearTimeout(closeTimer));
  node.addEventListener("mouseleave", () => (closeTimer = setTimeout(close, 400)));
  card = { overlay, node, link };
  place(node, link);
  requestAnimationFrame(() => node.classList.add("shown"));

  const reply = (await chrome.runtime.sendMessage({ type: "preview", url: link.href }).catch(() => null)) as Reply | null;
  if (card?.node !== node) return;
  node.replaceChildren(reply?.ok ? render(reply.value) : failure(link.href, reply && !reply.ok ? reply.error : "No preview for this link."));
  place(node, link);
}

function render(preview: Preview): HTMLElement {
  const open = el("button", { class: "primary", text: "Open in new tab" });
  open.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "open", url: preview.url }).catch(() => undefined);
    close();
  });
  const parts: Node[] = [];
  // The service worker sends the image as a data: URL; the page itself never requests it.
  if (preview.image?.startsWith("data:image/")) {
    const img = el("img", { class: "image", attrs: { alt: "", loading: "eager", decoding: "async" } });
    img.addEventListener("error", () => img.remove());
    img.src = preview.image;
    parts.push(img);
  }
  const body = el("div", { class: "body" }, [
    el("div", { class: "site", text: preview.siteName }),
    el("div", { class: "title", text: preview.title ?? new URL(preview.url).pathname }),
    ...(preview.description ? [el("div", { class: "desc", text: preview.description })] : []),
    el("div", { class: "url", text: preview.url }),
    el("div", { class: "actions" }, [open]),
  ]);
  return el("div", {}, [...parts, body]);
}

function failure(href: string, message: string): HTMLElement {
  return el("div", { class: "body" }, [el("div", { class: "site", text: new URL(href).hostname }), el("div", { class: "note", text: message })]);
}

function place(node: HTMLElement, link: HTMLAnchorElement): void {
  const rect = link.getBoundingClientRect();
  const height = node.offsetHeight || 120;
  const below = rect.bottom + 8 + height < innerHeight;
  node.style.top = `${Math.max(8, below ? rect.bottom + 8 : rect.top - 8 - height)}px`;
  node.style.left = `${Math.min(Math.max(8, rect.left), innerWidth - Math.min(360, innerWidth - 16) - 8)}px`;
}

function close(): void {
  clearTimeout(closeTimer);
  card?.overlay.remove();
  card = null;
}
