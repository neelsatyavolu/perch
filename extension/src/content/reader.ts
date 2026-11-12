/**
 * Reader view, injected on demand: running it again closes it. Mozilla's Readability finds the
 * article; Perch sets it in Newsreader on the theme's colours, over the page, in a closed shadow root.
 */

import { Readability } from "@mozilla/readability";
import { createOverlay, el } from "./overlay";
import { sanitizeArticle } from "../reader/sanitize";

const TAG = "perch-reader";
const SIZES = [16, 18, 20, 22, 24] as const;
const PREFS_KEY = "reader";
/** Readability returns its best guess even on pages with no article; below this much text, say so instead. */
const MIN_ARTICLE_CHARS = 200;

const FONT_URL = "fonts/newsreader.woff2";

const CSS = `
.reader { position: fixed; inset: 0; overflow-y: auto; background: var(--card); color: var(--body); }
.reader:focus { outline: none; }
.reader.paper { --card: #FBFAF6; --elevated: #EFECE4; --ink: #16161A; --body: rgb(22 22 26 / 0.86); --mute: #676667;
  --hairline: rgb(22 22 26 / 0.1); --hairline-strong: rgb(22 22 26 / 0.22); --accent: #2A63CC; }
.reader.ink { --card: #141413; --elevated: #1A1A18; --ink: #F2F0EA; --body: rgb(242 240 234 / 0.86); --mute: #8B8A87;
  --hairline: rgb(242 240 234 / 0.08); --hairline-strong: rgb(242 240 234 / 0.18); --accent: #4C8DFF; }
.bar { position: sticky; top: 0; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 16px;
  background: var(--card); border-bottom: 1px solid var(--hairline); }
.bar .site { flex: 1; font: 12px/16px var(--mono); color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar button { min-width: 28px; padding: 0 12px; }
article { max-width: 680px; margin: 0 auto; padding: 48px 24px 96px; font-family: var(--serif); font-size: var(--size, 20px); line-height: 1.6; }
h1.title { font: 500 40px/1.15 var(--serif); color: var(--ink); margin: 0 0 12px; letter-spacing: -0.01em; }
.byline { font: 13px/20px var(--sans); color: var(--mute); margin-bottom: 32px; }
.content h1, .content h2, .content h3, .content h4 { font-family: var(--sans); font-weight: 500; color: var(--ink); line-height: 1.3; margin: 1.6em 0 0.5em; }
.content h2 { font-size: 1.25em; } .content h3 { font-size: 1.1em; } .content h4 { font-size: 1em; }
.content p, .content ul, .content ol, .content blockquote, .content pre, .content figure, .content table { margin: 0 0 1em; }
.content a { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--accent); }
.content img, .content video, .content svg { max-width: 100%; height: auto; border-radius: 8px; }
.content figcaption { font: 13px/20px var(--sans); color: var(--mute); margin-top: 8px; }
.content blockquote { border-left: 2px solid var(--hairline-strong); padding-left: 16px; color: var(--mute); }
.content pre, .content code { font-family: var(--mono); font-size: 0.8em; }
.content pre { background: var(--elevated); padding: 12px 16px; border-radius: 8px; overflow-x: auto; }
.content table { border-collapse: collapse; width: 100%; font: 14px/1.45 var(--sans); }
.content td, .content th { border-bottom: 1px solid var(--hairline); padding: 6px 8px; text-align: left; }
.content hr { border: 0; border-top: 1px solid var(--hairline); margin: 2em 0; }
.empty { max-width: 480px; margin: 120px auto; text-align: center; font: 14px/1.45 var(--sans); color: var(--mute); }
`;

type Prefs = { size: number; theme: "system" | "ink" | "paper" };

const existing = document.querySelector(TAG);
if (existing) close(existing as HTMLElement);
else void open();

async function open(): Promise<void> {
  const prefs = await loadPrefs();
  loadSerif();
  const article = new Readability(document.cloneNode(true) as Document, { charThreshold: 300 }).parse();
  const overlay = createOverlay(TAG, CSS);
  const view = el("div", { class: "perch reader", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Reader view", tabindex: "-1" } });
  // Focus goes back where it was when the reader closes from inside (Close or Escape).
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dismiss = () => {
    close(overlay.host);
    returnTo?.focus({ preventScroll: true });
  };
  const closeButton = el("button", { text: "Close", attrs: { "aria-label": "Close reader view" } });
  closeButton.addEventListener("click", dismiss);
  const smaller = el("button", { text: "A−", attrs: { "aria-label": "Smaller text" } });
  const larger = el("button", { text: "A+", attrs: { "aria-label": "Larger text" } });
  const theme = el("button", { text: themeLabel(prefs.theme) });
  const bar = el("div", { class: "bar" }, [el("div", { class: "site", text: location.hostname }), smaller, larger, theme, closeButton]);

  let current = prefs;
  const apply = (next: Prefs) => {
    current = next;
    view.style.setProperty("--size", `${next.size}px`);
    view.classList.toggle("ink", next.theme === "ink");
    view.classList.toggle("paper", next.theme === "paper");
    theme.textContent = themeLabel(next.theme);
    void chrome.storage.local.set({ [PREFS_KEY]: next }).catch(() => undefined);
  };
  smaller.addEventListener("click", () => apply({ ...current, size: stepSize(current.size, -1) }));
  larger.addEventListener("click", () => apply({ ...current, size: stepSize(current.size, 1) }));
  theme.addEventListener("click", () => apply({ ...current, theme: current.theme === "system" ? "ink" : current.theme === "ink" ? "paper" : "system" }));

  const body = article?.content && (article.length ?? 0) >= MIN_ARTICLE_CHARS
    ? el("article", {}, [
        el("h1", { class: "title", text: article.title || document.title }),
        ...(article.byline || article.siteName ? [el("div", { class: "byline", text: [article.byline, article.siteName].filter(Boolean).join(" · ") })] : []),
        sanitizeArticle(article.content, location.href),
      ])
    : el("div", { class: "empty", text: "Reader view could not find an article on this page." });
  view.append(bar, body);
  overlay.root.append(view);
  apply(current);

  const previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
  overlay.host.dataset.overflow = previousOverflow;
  view.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismiss();
    else if (event.key === "Tab") trapTab(event, view, overlay.root);
  });
  view.focus();
}

/** Keeps Tab inside the reader: it covers the page, so focus must not wander to the page underneath. */
function trapTab(event: KeyboardEvent, view: HTMLElement, root: ShadowRoot): void {
  const stops = [...view.querySelectorAll<HTMLElement>("button, a[href]")];
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return;
  const at = root.activeElement;
  if (event.shiftKey && (at === first || at === view)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && at === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Fonts declared inside a shadow root do not load, so Newsreader is added to the document's font set. */
function loadSerif(): void {
  if ([...document.fonts].some((face) => face.family === "Newsreader")) return;
  try {
    const face = new FontFace("Newsreader", `url(${chrome.runtime.getURL(FONT_URL)})`, { weight: "200 800", display: "swap" });
    document.fonts.add(face);
    void face.load().catch(() => undefined);
  } catch {
    // The serif falls back to Georgia.
  }
}

function close(host: HTMLElement): void {
  document.documentElement.style.overflow = host.dataset.overflow ?? "";
  host.remove();
}

async function loadPrefs(): Promise<Prefs> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(PREFS_KEY).catch(() => ({}));
  const raw = stored[PREFS_KEY] as Partial<Prefs> | undefined;
  const size = SIZES.includes(raw?.size as (typeof SIZES)[number]) ? raw!.size! : 20;
  const theme = raw?.theme === "ink" || raw?.theme === "paper" ? raw.theme : "system";
  return { size, theme };
}

function stepSize(size: number, direction: -1 | 1): number {
  const index = SIZES.indexOf(size as (typeof SIZES)[number]);
  return SIZES[Math.min(SIZES.length - 1, Math.max(0, index + direction))]!;
}

function themeLabel(theme: Prefs["theme"]): string {
  return `Colours: ${theme === "system" ? "Auto" : theme === "ink" ? "Dark" : "Light"}`;
}

