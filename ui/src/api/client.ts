/** The app API from a page: JSON over fetch with the token, and events over one WebSocket. */

import type { AppEvent, AppInfo, ArtifactKind, ArtifactMeta, Chat, ChatMessage, ChatSettings, ChatSummary, RunSnapshot, TabInfo, WindowState } from "./types";

export type ChatPayload = { chat: Chat | null; run: RunSnapshot | null; artifacts: ArtifactMeta[] };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type Client = ReturnType<typeof createClient>;

type Deps = { fetch?: typeof fetch; WebSocket?: typeof WebSocket; retryMs?: number };

export function createClient(api: string, token: string, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch.bind(globalThis);
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const message = await res
        .json()
        .then((j: { error?: string }) => j.error)
        .catch(() => undefined);
      throw new ApiError(message ?? `Perch did not answer (${res.status}). Try again in a moment`, res.status);
    }
    return (res.headers.get("content-type") ?? "").includes("json") ? ((await res.json()) as T) : ((await res.text()) as T);
  }

  return {
    info: () => call<AppInfo>("GET", "/api/info"),
    chats: () => call<ChatSummary[]>("GET", "/api/chats"),
    createChat: (init: { title?: string; settings?: Partial<ChatSettings> } = {}) => call<Chat>("POST", "/api/chats", init),
    chat: (id: string) => call<ChatPayload>("GET", `/api/chats/${encodeURIComponent(id)}`),
    patchChat: (id: string, patch: { title?: string; draft?: string; scrollTop?: number; settings?: Partial<ChatSettings> }) => call<Chat>("PATCH", `/api/chats/${encodeURIComponent(id)}`, patch),
    deleteChat: (id: string) => call<{ removed: string }>("DELETE", `/api/chats/${encodeURIComponent(id)}`),
    send: (id: string, text: string, context?: TabInfo) => call<{ runId: string; message: ChatMessage }>("POST", `/api/chats/${encodeURIComponent(id)}/messages`, context ? { text, context } : { text }),
    cancel: (id: string) => call<{ stopped: boolean }>("POST", `/api/chats/${encodeURIComponent(id)}/cancel`, {}),
    branch: (id: string, messageId: string) => call<Chat>("POST", `/api/chats/${encodeURIComponent(id)}/branch`, { messageId }),
    exportChat: (id: string) => call<string>("GET", `/api/chats/${encodeURIComponent(id)}/export`),
    artifact: (id: string, version?: number) => call<{ meta: ArtifactMeta; content: string | null }>("GET", `/api/artifacts/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`),
    saveArtifact: (chatId: string, a: { title: string; kind: ArtifactKind; content: string; language?: string; mime?: string }) => call<ArtifactMeta>("POST", `/api/chats/${encodeURIComponent(chatId)}/artifacts`, a),
    decide: (approvalId: string, approved: boolean) => call<{ ok: true }>("POST", `/api/approvals/${encodeURIComponent(approvalId)}`, { approved }),
    windowState: (windowId: string) => call<WindowState>("GET", `/api/windows/${encodeURIComponent(windowId)}`),
    tabChat: (tabId: string) => call<ChatPayload>("GET", `/api/tabs/${encodeURIComponent(tabId)}/chat`),
    openSideChat: (tabId: string, windowId: string, chatId?: string, settings?: Partial<ChatSettings>) =>
      call<Chat>("POST", `/api/tabs/${encodeURIComponent(tabId)}/chat`, chatId ? { windowId, chatId } : { windowId, ...(settings && Object.keys(settings).length ? { settings } : {}) }),

    /** Calls onEvent for every app event; reconnects after a drop. Returns a function that closes it. */
    connect(onEvent: (event: AppEvent) => void, onStatus?: (connected: boolean) => void): () => void {
      const Socket = deps.WebSocket ?? WebSocket;
      let socket: WebSocket | null = null;
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const open = () => {
        socket = new Socket(`${api.replace(/^http/, "ws")}/ws`, ["perch-app", `token.${token}`]);
        socket.onopen = () => onStatus?.(true);
        socket.onmessage = (m) => {
          if (typeof m.data !== "string" || m.data === "pong") return;
          try {
            onEvent(JSON.parse(m.data) as AppEvent);
          } catch {
            // A malformed frame is dropped; the next full load corrects the view.
          }
        };
        socket.onclose = () => {
          onStatus?.(false);
          if (!closed) timer = setTimeout(open, deps.retryMs ?? 1000);
        };
      };
      open();
      return () => {
        closed = true;
        clearTimeout(timer);
        socket?.close();
      };
    },
  };
}
