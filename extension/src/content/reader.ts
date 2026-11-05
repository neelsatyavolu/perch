/**
 * Reader view, injected on demand: running it again closes it. Mozilla's Readability finds the
 * article; Perch sets it in Geist Serif on the theme's colours, over the page, in a closed shadow root.
 */

import { Readability } from "@mozilla/readability";
import { createOverlay, el } from "./overlay";
import { sanitizeArticle } from "../reader/sanitize";

const TAG = "perch-reader";
const SIZES = [16, 18, 20, 22, 24] as const;
const PREFS_KEY = "reader";
/** Readability returns its best guess even on pages with no article; below this much text, say so instead. */
const MIN_ARTICLE_CHARS = 200;

const CSS = `
.reader { position: fixed; inset: 0; overflow-y: auto; background: var(--card); color: var(--body); }
.reader.paper { --card: #FFFFFF; --elevated: #ECEEF1; --ink: #0A0A0C; --body: rgb(10 10 12 / 0.82); --mute: #5F6366;
  --hairline: rgb(0 0 0 / 0.06); --hairline-strong: rgb(0 0 0 / 0.12); --accent: #2B68D6; }
.reader.ink { --card: #0E0E10; --elevated: #1A1A1E; --ink: #FCFDFF; --body: rgb(252 253 255 / 0.86); --mute: #A1A4A5;
  --hairline: rgb(255 255 255 / 0.06); --hairline-strong: rgb(255 255 255 / 0.14); --accent: #4C8DFF; }
.bar { position: sticky; top: 0; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 16px;
  background: var(--card); border-bottom: 1px solid var(--hairline); }
.bar .site { flex: 1; font: 12px/16px var(--mono); color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar button { min-width: 28px; padding: 0 10px; }
article { max-width: 680px; margin: 0 auto; padding: 48px 24px 96px; font-family: var(--serif); font-size: var(--size, 20px); line-height: 1.6; }
h1.title { font: 500 40px/1.15 var(--serif); color: var(--ink); margin: 0 0 12px; letter-spacing: -0.01em; }
.byline { font: 13px/1.45 var(--sans); color: var(--mute); margin-bottom: 32px; }
.content h1, .content h2, .content h3, .content h4 { font-family: var(--sans); font-weight: 500; color: var(--ink); line-height: 1.3; margin: 1.6em 0 0.5em; }
.content h2 { font-size: 1.25em; } .content h3 { font-size: 1.1em; } .content h4 { font-size: 1em; }
.content p, .content ul, .content ol, .content blockquote, .content pre, .content figure, .content table { margin: 0 0 1em; }
.content a { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--accent); }
.content img, .content video, .content svg { max-width: 100%; height: auto; border-radius: 8px; }
.content figcaption { font: 13px/1.45 var(--sans); color: var(--mute); margin-top: 8px; }
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
  const article = new Readability(document.cloneNode(true) as Document, { charThreshold: 300 }).parse();
  const overlay = createOverlay(TAG, CSS);
  const view = el("div", { class: "perch reader", attrs: { role: "dialog", "aria-label": "Reader view", tabindex: "-1" } });
  const closeButton = el("button", { text: "Close", attrs: { "aria-label": "Close reader view" } });
  closeButton.addEventListener("click", () => close(overlay.host));
  const smaller = el("button", { text: "A−", attrs: { "aria-label": "Smaller text" } });
  const larger = el("button", { text: "A+", attrs: { "aria-label": "Larger text" } });
  const theme = el("button", { text: themeLabel(prefs.theme), attrs: { "aria-label": "Change colours" } });
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

  const body = article?.content && article.length >= MIN_ARTICLE_CHARS
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
  view.addEventListener("keydown", (event) => event.key === "Escape" && close(overlay.host));
  view.focus();
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
  return theme === "system" ? "Auto" : theme === "ink" ? "Dark" : "Light";
}

