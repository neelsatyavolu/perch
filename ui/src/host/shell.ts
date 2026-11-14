/**
 * The trusted shell around a chat page (plan 3b task 8). It runs at chrome://perch-chat or
 * chrome://perch-side-chat, frames the untrusted chat page, and relays a fixed list of host calls
 * from that frame to the browser with `chrome.send("perchHost", [id, method, args])`. Answers come
 * back through `cr.webUIResponse`, and dictation text through
 * `cr.webUIListenerCallback("perch-dictation", {text, final})`. Anything else from the frame is
 * dropped, and `openTab` takes only web pages and artifacts.
 */

import { THEMES } from "../theme/names.gen";
import { shownTheme } from "../theme/theme";
import { chatIdArg, isAppearance, type HostAppearance, FRAME_ORIGINS, HOST_EVENT, HOST_METHODS, HOST_REPLY, HOST_REQUEST, openableUrl, type HostMethod } from "./protocol";

type Send = (message: string, args: unknown[]) => void;
type Reply = { type: string; id?: string; ok?: boolean; result?: unknown; error?: string; event?: string; data?: unknown };

export type Relay = {
  /** A message the shell window received. */
  onMessage(source: unknown, origin: string, data: unknown): void;
  /** The browser's answer to a relayed call (cr.webUIResponse). */
  onResponse(id: string, ok: boolean, response: unknown): void;
  /** A browser event (cr.webUIListenerCallback). */
  onEvent(name: string, data: unknown): void;
};

/** What the chat tab shows in the tab strip: the chat's title, and whether it waits for the person. */
export type TabState = { title: string; waiting: boolean };

export function createRelay(opts: { send: Send; frameOrigin: string; isFrame: (source: unknown) => boolean; post: (msg: Reply) => void; onTabState?: (state: TabState) => void }): Relay {
  const calls = new Map<string, string>();
  let next = 0;
  const reply = (id: string, ok: boolean, payload: unknown) =>
    opts.post(ok ? { type: HOST_REPLY, id, ok: true, result: payload } : { type: HOST_REPLY, id, ok: false, error: typeof payload === "string" ? payload : "Perch couldn't do that" });
  return {
    onMessage(source, origin, data) {
      if (!opts.isFrame(source) || origin !== opts.frameOrigin || typeof data !== "object" || data === null) return;
      const msg = data as { type?: unknown; id?: unknown; method?: unknown; args?: unknown };
      if (msg.type !== HOST_REQUEST || typeof msg.id !== "string" || msg.id.length > 64) return;
      if (!(HOST_METHODS as readonly unknown[]).includes(msg.method)) return reply(msg.id, false, "Perch can't do that from the chat");
      const method = msg.method as HostMethod;
      // The tab's own title and icon are the shell's to set; nothing reaches the browser.
      if (method === "setTabState") {
        const s = (Array.isArray(msg.args) ? msg.args[0] : undefined) as Partial<TabState> | undefined;
        if (typeof s?.title !== "string" || typeof s.waiting !== "boolean") return reply(msg.id, false, "Bad tab state");
        opts.onTabState?.({ title: s.title.slice(0, 120), waiting: s.waiting });
        return reply(msg.id, true, null);
      }
      let args: unknown[] = [];
      if (method === "openTab") {
        const url = openableUrl(Array.isArray(msg.args) ? msg.args[0] : undefined);
        if (!url) return reply(msg.id, false, "The chat can open web pages and artifacts only");
        args = [url];
      } else if (method === "openFullChat") {
        const chat = chatIdArg(Array.isArray(msg.args) ? msg.args[0] : undefined);
        if (!chat) return reply(msg.id, false, "Unknown chat");
        args = [chat];
      }
      const callId = `shell-${++next}`;
      calls.set(callId, msg.id);
      opts.send("perchHost", [callId, method, args]);
    },
    onResponse(id, ok, response) {
      const frameId = calls.get(id);
      if (!frameId) return;
      calls.delete(id);
      const message = (response as { message?: unknown } | null)?.message;
      reply(frameId, ok, ok ? response : typeof message === "string" ? message : response);
    },
    onEvent(name, data) {
      if (name === "perch-dictation") opts.post({ type: HOST_EVENT, event: "dictation", data });
      else if (name === "perch-appearance") opts.post({ type: HOST_EVENT, event: "appearance", data });
    },
  };
}

type ShellWindow = Window & { chrome?: { send?: Send }; cr?: Record<string, unknown> };

/** Starts the shell page: frames `page` from the matching untrusted origin and relays its host calls. */
export function startShell(win: ShellWindow, page: "chat.html" | "sidebar.html"): void {
  const frameOrigin = page === "sidebar.html" ? FRAME_ORIGINS[1]! : FRAME_ORIGINS[0]!;
  const send = win.chrome?.send;
  const frame = win.document.createElement("iframe");
  frame.title = "Perch chat";
  frame.src = `${frameOrigin}/${page}${win.location.search}`;
  win.document.body.append(frame);
  if (typeof send !== "function") return;
  const relay = createRelay({
    send: (m, a) => send.call(win.chrome, m, a),
    frameOrigin,
    isFrame: (source) => source !== null && source === frame.contentWindow,
    post: (msg) => frame.contentWindow?.postMessage(msg, frameOrigin),
    // A chat waiting for the person says so in the tab strip: "Needs you" first, and the icon's dot.
    onTabState: ({ title, waiting }) => {
      win.document.title = `${waiting ? "Needs you · " : ""}${title || "Chat"} · Perch`;
      const icon = win.document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (icon) icon.href = waiting ? "./favicon-waiting.svg" : "./favicon.svg";
    },
  });
  win.addEventListener("message", (e) => relay.onMessage(e.source, e.origin, e.data));
  // The shell paints the chosen theme's canvas, so no other colour shows around or before the frame.
  const paint = (a: unknown) => {
    if (isAppearance(a)) win.document.documentElement.style.background = shellCanvas(a, (q) => win.matchMedia(q).matches);
  };
  win.cr = {
    ...win.cr,
    webUIResponse: (id: string, ok: boolean, response: unknown) => (id === APPEARANCE_ID ? ok && paint(response) : relay.onResponse(id, ok, response)),
    webUIListenerCallback: (name: string, data: unknown) => {
      if (name === "perch-appearance") paint(data);
      relay.onEvent(name, data);
    },
  };
  send.call(win.chrome, "perchHost", [APPEARANCE_ID, "getAppearance", []]);
}

const APPEARANCE_ID = "shell-appearance";

/** The canvas colour of the theme an Appearance shows now (see applyAppearance in theme.ts). */
export function shellCanvas(a: HostAppearance, matches: (query: string) => boolean): string {
  const id = shownTheme(a, matches);
  return (THEMES.find((t) => t.id === id) ?? THEMES[0]).canvas;
}
