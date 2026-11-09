/** Runs cookie-banner rules against a document: finds a showing banner and clicks through a reject route. */

import { CMP_RULES, isSafeToClick, type CmpRule, type Step, type Target } from "./rules";

export type EngineOptions = {
  /** Stop watching the page this long after it loaded; banners appear early, and later ones were opened by the user. */
  windowMs?: number;
  /** How long a step waits for its control to appear. */
  stepTimeoutMs?: number;
  /** Returns a shadow root even when it is closed (chrome.dom.openOrClosedShadowRoot in content scripts). */
  shadowRootOf?: (host: Element) => ShadowRoot | null;
};

type Root = Document | ShadowRoot;

/** Wait this long for the page to go quiet before looking... */
const QUIET_MS = 100;
/** ...but look at least this often while it keeps changing (animations, tickers, players). */
const MAX_GAP_MS = 250;

export function watchForBanners(doc: Document, onDone: (cmp: string) => void, opts: EngineOptions = {}): () => void {
  const windowMs = opts.windowMs ?? 10_000;
  const stepTimeoutMs = opts.stepTimeoutMs ?? 4_000;
  const shadowRootOf = opts.shadowRootOf ?? ((host: Element) => host.shadowRoot);
  let running = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCheck = 0;

  const stop = () => {
    finished = true;
    observer.disconnect();
    clearTimeout(deadline);
    clearTimeout(timer);
  };

  const check = async () => {
    if (running || finished) return;
    lastCheck = Date.now();
    const match = findShowing(doc, shadowRootOf);
    if (!match) return;
    running = true;
    observer.disconnect();
    const ok = await runRule(match.rule, match.root, stepTimeoutMs);
    // One attempt per page: a rule that failed is not retried, so Perch never clicks around a banner it does not understand.
    stop();
    if (ok) onDone(match.rule.name);
  };

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    if (Date.now() - lastCheck >= MAX_GAP_MS) void check();
    else timer = setTimeout(check, QUIET_MS);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  const deadline = setTimeout(stop, windowMs);
  void check();
  return stop;
}

function findShowing(doc: Document, shadowRootOf: (host: Element) => ShadowRoot | null): { rule: CmpRule; root: Root } | null {
  for (const rule of CMP_RULES) {
    const root = rootFor(doc, rule, shadowRootOf);
    if (!root) continue;
    const banner = [...root.querySelectorAll(rule.detect)].some(visible);
    if (banner && rule.routes.some((route) => route[0] && canStart(root, route[0]))) return { rule, root };
  }
  return null;
}

function rootFor(doc: Document, rule: CmpRule, shadowRootOf: (host: Element) => ShadowRoot | null): Root | null {
  if (!rule.shadowHost) return doc;
  const host = doc.querySelector(rule.shadowHost);
  return host ? shadowRootOf(host) : null;
}

function canStart(root: Root, step: Step): boolean {
  if (step.click) return findTarget(root, step.click) !== null;
  return step.uncheck ? root.querySelector(step.uncheck) !== null : false;
}

async function runRule(rule: CmpRule, root: Root, stepTimeoutMs: number): Promise<boolean> {
  const route = rule.routes.find((r) => r[0] && canStart(root, r[0]));
  if (!route) return false;
  for (const step of route) {
    const ok = await runStep(root, step, stepTimeoutMs);
    if (!ok && !step.optional) return false;
  }
  return true;
}

async function runStep(root: Root, step: Step, timeoutMs: number): Promise<boolean> {
  if (step.uncheck) {
    for (const box of root.querySelectorAll<HTMLInputElement>(step.uncheck)) {
      if (box.checked && !box.disabled) box.click();
    }
    return true;
  }
  if (!step.click) return false;
  // An optional control is either there right after the previous click or not at all.
  const limit = Date.now() + (step.optional ? Math.min(timeoutMs, 1_000) : timeoutMs);
  for (;;) {
    const target = findTarget(root, step.click);
    if (target) {
      target.click();
      await sleep(250);
      return true;
    }
    if (Date.now() > limit) return false;
    await sleep(100);
  }
}

function findTarget(root: Root, targets: readonly Target[]): HTMLElement | null {
  for (const target of targets) {
    const scopes = target.within ? [...root.querySelectorAll(target.within)] : [root];
    const pattern = target.text ? new RegExp(target.text, "i") : null;
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll<HTMLElement>(target.selector)) {
        const text = el.innerText || el.textContent || el.getAttribute("aria-label") || "";
        if (!visible(el) || (pattern && !pattern.test(text)) || !isSafeToClick(text)) continue;
        return el;
      }
    }
  }
  return null;
}

function visible(el: Element): boolean {
  return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
