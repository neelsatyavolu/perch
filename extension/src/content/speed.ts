/** Content script: `[` and `]` change the playback speed of the page's video. */

import { mainVideo, stepRate } from "../media/video";
import { createOverlay, el, isEditable, type Overlay } from "./overlay";

const CSS = `
.chip { position: fixed; padding: 0 10px; height: 28px; display: flex; align-items: center; border-radius: 8px;
  background: var(--card); color: var(--ink); border: 1px solid var(--hairline-strong); box-shadow: var(--shadow);
  font: 500 13px/1 var(--mono); font-variant-numeric: tabular-nums; transition: opacity 180ms var(--ease); }
`;

let chip: { overlay: Overlay; node: HTMLElement; timer?: ReturnType<typeof setTimeout> } | null = null;

window.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "[" && event.key !== "]") return;
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    if (isEditable(event.composedPath()[0]) || isEditable(document.activeElement)) return;
    const video = mainVideo(document);
    if (!video) return;
    video.playbackRate = stepRate(video.playbackRate, event.key === "]" ? 1 : -1);
    event.preventDefault();
    event.stopImmediatePropagation();
    showRate(video);
  },
  true,
);

function showRate(video: HTMLVideoElement): void {
  if (!chip) {
    const overlay = createOverlay("perch-speed", CSS);
    const node = el("div", { class: "perch chip", attrs: { role: "status", "aria-live": "polite" } });
    overlay.root.append(node);
    chip = { overlay, node };
  }
  const rect = video.getBoundingClientRect();
  chip.node.textContent = `${video.playbackRate}×`;
  chip.node.style.left = `${Math.max(8, rect.left + 12)}px`;
  chip.node.style.top = `${Math.max(8, rect.top + 12)}px`;
  chip.node.style.opacity = "1";
  clearTimeout(chip.timer);
  const current = chip;
  current.timer = setTimeout(() => (current.node.style.opacity = "0"), 900);
}
