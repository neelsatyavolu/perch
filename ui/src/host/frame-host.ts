/**
 * `window.perchHost` for a chat page framed by Perch's trusted shell (plan 3b task 8). The chat runs
 * at chrome-untrusted:// with no browser bindings; the few things it needs from the browser go to
 * the shell (chrome://perch-chat or chrome://perch-side-chat) over postMessage, which relays only a
 * fixed list of calls (shell.ts). Replies are matched by id and accepted only from the parent
 * window at one of the shell origins.
 */

import { HOST_EVENT, HOST_REPLY, HOST_REQUEST, isAppearance, SHELL_ORIGINS, type AttachedFile, type HostAppearance, type HostMethod } from "./protocol";

/** What a page can ask of the browser. Each part is missing when the page has no host for it. */
export type PageHost = {
  close?: () => void;
  openTab?: (url: string) => void;
  /** Opens this chat in the full chat page, in a new tab (the side chat closes). */
  openFullChat?: (chatId: string) => void;
  /** Opens Perch's settings in a tab. */
  openSettings?: () => void;
  /** The browser's Appearance settings, and a way to hear when they change. Returns a cleanup. */
  getAppearance?: () => Promise<HostAppearance | null>;
  onAppearance?: (fn: (appearance: HostAppearance) => void) => () => void;
  /** Shows the browser's open panel; resolves to ids for the files the user picked (none when cancelled). */
  chooseFiles?: () => Promise<AttachedFile[]>;
  /** Files copied in Finder (the clipboard's file paths), attached like picked ones; none when nothing was copied. */
  pastedFiles?: () => Promise<AttachedFile[]>;
  /** Starts on-device dictation; `onText` gets the words so far, and `final` once speech ends. */
  startDictation?: (onText: (text: string, final: boolean) => void) => Promise<void>;
  stopDictation?: () => Promise<void>;
  /** The tab's title and whether the chat waits for the person (the shell shows it in the tab strip). */
  setTabState?: (state: { title: string; waiting: boolean }) => void;
};

type Win = Pick<Window, "parent" | "addEventListener"> & { location: { ancestorOrigins?: ArrayLike<string> } };

const TIMEOUT_MS = 10 * 60_000;

export function createFrameHost(win: Win): PageHost | undefined {
  const parent = win.parent;
  const ancestor = win.location.ancestorOrigins?.[0];
  if (!parent || parent === (win as unknown) || !ancestor || !SHELL_ORIGINS.includes(ancestor)) return undefined;
  const shell = ancestor;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let dictation: ((text: string, final: boolean) => void) | null = null;
  const appearanceListeners = new Set<(a: HostAppearance) => void>();
  let next = 0;

  win.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== parent || e.origin !== shell || typeof e.data !== "object" || e.data === null) return;
    const msg = e.data as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown; event?: unknown; data?: unknown };
    if (msg.type === HOST_REPLY && typeof msg.id === "string") {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok === true) waiter.resolve(msg.result);
      else waiter.reject(new Error(typeof msg.error === "string" ? msg.error : "Perch couldn't do that"));
    } else if (msg.type === HOST_EVENT && msg.event === "dictation") {
      const d = (msg.data ?? {}) as { text?: unknown; final?: unknown };
      if (typeof d.text === "string") dictation?.(d.text, d.final === true);
      if (d.final === true) dictation = null;
    } else if (msg.type === HOST_EVENT && msg.event === "appearance" && isAppearance(msg.data)) {
      for (const fn of appearanceListeners) fn(msg.data);
    }
  });

  const call = <T>(method: HostMethod, args: unknown[] = []) =>
    new Promise<T>((resolve, reject) => {
      const id = `h${++next}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Perch didn't answer. Try again"));
      }, TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      parent.postMessage({ type: HOST_REQUEST, id, method, args }, shell);
    });

  return {
    close: () => void call("close").catch(() => undefined),
    openTab: (url) => void call("openTab", [url]).catch(() => undefined),
    openFullChat: (chatId) => void call("openFullChat", [chatId]).catch(() => undefined),
    openSettings: () => void call("openSettings").catch(() => undefined),
    setTabState: (state) => void call("setTabState", [state]).catch(() => undefined),
    getAppearance: async () => {
      const a = await call<unknown>("getAppearance").catch(() => null);
      return isAppearance(a) ? a : null;
    },
    onAppearance: (fn) => {
      appearanceListeners.add(fn);
      return () => appearanceListeners.delete(fn);
    },
    chooseFiles: async () => {
      const files = await call<unknown>("chooseFiles");
      return Array.isArray(files) ? files.filter(isFile) : [];
    },
    pastedFiles: async () => {
      const files = await call<unknown>("pastedFiles").catch(() => []);
      return Array.isArray(files) ? files.filter(isFile) : [];
    },
    startDictation: async (onText) => {
      dictation = onText;
      try {
        await call("startDictation");
      } catch (error) {
        dictation = null;
        throw error;
      }
    },
    stopDictation: () => call<void>("stopDictation"),
  };
}

function isFile(f: unknown): f is AttachedFile {
  const o = f as Partial<AttachedFile> | null;
  return typeof o?.id === "string" && typeof o.name === "string" && typeof o.size === "number";
}
