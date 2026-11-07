/**
 * Content script: a one-line notice when a streaming service refuses to play in this build
 * (spec 5.2: never fail silently). Dismissing it keeps it away for that service.
 */

import { DRM_EVENT, noticeText, serviceFor } from "../drm/services";
import { createOverlay, el } from "./overlay";

const KEY = "drmDismissed";
let shown = false;

const CSS = `
.bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 12px; align-items: center;
  max-width: min(640px, calc(100vw - 32px)); padding: 10px 12px 10px 16px; background: var(--card); color: var(--ink);
  border: 1px solid var(--hairline-strong); border-radius: 12px; box-shadow: var(--shadow); }
.bar p { margin: 0; }
`;

async function show(): Promise<void> {
  const service = serviceFor(location.hostname);
  if (!service || shown) return;
  shown = true;
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Record<string, boolean> | undefined;
  if (stored?.[service.id]) return;
  const overlay = createOverlay("perch-drm-notice", CSS);
  const close = el("button", { text: "Dismiss" });
  const bar = el("div", { class: "perch bar", attrs: { role: "status" } }, [el("p", { text: noticeText(service.name) }), close]);
  close.addEventListener("click", async () => {
    overlay.remove();
    const now = (await chrome.storage.local.get(KEY))[KEY] as Record<string, boolean> | undefined;
    await chrome.storage.local.set({ [KEY]: { ...now, [service.id]: true } });
  });
  overlay.root.append(bar);
}

window.addEventListener(DRM_EVENT, () => void show());
