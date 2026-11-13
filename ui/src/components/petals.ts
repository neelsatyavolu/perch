/**
 * Sakura mode's petal burst (DESIGN.md): sending a message lets six petals fall from the send
 * button over 900ms. Only in Sakura mode and never with Reduce Motion. The petals are plain
 * decorative nodes on <body>, animated with transform and opacity, and removed when they land.
 */

import { PETAL_PATH } from "./icon";

const COUNT = 6;
const DURATION_MS = 900;
const SVG_NS = "http://www.w3.org/2000/svg";

export function sakuraOn(doc: Document = document): boolean {
  return doc.documentElement.dataset.sakura !== undefined;
}

function reducedMotion(win: Window): boolean {
  return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Lets petals fall from `from`. Does nothing outside Sakura mode or with Reduce Motion. */
export function petalBurst(from: Element | null, win: Window = window): void {
  const doc = win.document;
  if (!from || !sakuraOn(doc) || reducedMotion(win)) return;
  const box = from.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  for (let i = 0; i < COUNT; i++) {
    const size = 9 + (i % 3) * 2;
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("petal-burst", `tint-${i % 3}`);
    svg.style.left = `${x - size / 2}px`;
    svg.style.top = `${y - size / 2}px`;
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", PETAL_PATH);
    svg.appendChild(path);
    doc.body.appendChild(svg);
    // Fan out upward and to the left, away from the composer's edge, then fall and fade.
    const angle = Math.PI * (0.55 + (i / (COUNT - 1)) * 0.6);
    const reach = 28 + (i % 2) * 16;
    const dx = Math.cos(angle) * reach;
    const dy = -Math.sin(angle) * reach;
    const spin = (i % 2 ? 1 : -1) * (160 + i * 30);
    const animation = svg.animate(
      [
        { transform: "translate(0, 0) rotate(0deg) scale(0.6)", opacity: 0 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${spin / 2}deg) scale(1)`, opacity: 0.9, offset: 0.35 },
        { transform: `translate(${dx * 1.4}px, ${dy + 56}px) rotate(${spin}deg) scale(0.9)`, opacity: 0 },
      ],
      { duration: DURATION_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", delay: i * 40 },
    );
    const remove = () => svg.remove();
    animation.onfinish = remove;
    animation.oncancel = remove;
  }
}
