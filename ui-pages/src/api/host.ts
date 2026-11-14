/**
 * `window.perch` inside Perch. The browser serves `config.js` before the page's own script; it sets
 * `window.perchApp = {api, token}` (perchd's loopback address and this session's page token) and
 * gives the page `chrome.send`. Settings the browser owns go to the browser as
 * `chrome.send("perch.call", [id, method, args])`, answered through `cr.webUIResponse`; every other
 * method goes to perchd as `POST /api/pages/<method>` with the args array. Events come from both:
 * the browser calls `cr.webUIListenerCallback("perch-event", name, data)`, and perchd sends
 * `{type: "pages.event", event, data}` on its WebSocket.
 */

import type { Bridge } from "./rpc";

/** Methods the browser answers itself; perchd answers everything else. */
export const BROWSER_METHODS: ReadonlySet<string> = new Set([
  "getAppearance", "setAppearance",
  "getPrivacy", "setPrivacy", "setBackgroundConnection", "removeBlockerException", "listSiteData", "forgetSite",
  "openPage", "chooseFile", "openFullDiskAccess", "submitQuery", "autocompleteAddress", "openAddress", "openChat", "newChat",
  "getAbout", "checkForUpdates", "installUpdate", "setAutoUpdate",
  "listBuiltInExtensions", "setBuiltInExtension",
  "getMemorySaver", "setMemorySaver", "addSleepRule", "listTabMemory",
  "queryCommandBar", "runCommandBarItem", "closeCommandBar", "openCommandBar", "showAgentTab",
  "revealRecoveryKey", "getSecurity", "exportBackup", "restoreFromRecoveryKey", "startFresh",
]);

type AppConfig = { readonly api: string; readonly token: string };
type HostWindow = Window & {
  perchApp?: Partial<AppConfig>;
  chrome?: { send?: (message: string, args: unknown[]) => void };
  cr?: Record<string, unknown>;
  perch?: Bridge;
  WebSocket?: typeof WebSocket;
};
type Listener = (data: unknown) => void;

/** A refusal the page can show: the browser's {code, message} or perchd's {error}. */
export class HostError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

const UNREACHABLE = "Perch's agent isn't running. Restart Perch and try again.";
/** How long a call waits for perchd to come up (it starts with the browser, a moment after the first page). */
const STARTUP_WAIT_MS = 20_000;
const RETRY_MS = 500;

function readConfig(win: HostWindow): AppConfig | null {
  const app = win.perchApp;
  return typeof app?.api === "string" && app.api.startsWith("http://127.0.0.1:") && typeof app.token === "string" && app.token
    ? { api: app.api, token: app.token }
    : null;
}

/**
 * Loads config.js again: the browser writes it fresh for each request, so a page that opened
 * before perchd was up (the welcome page on first launch) learns where perchd is once it is.
 */
function reloadConfig(win: HostWindow): Promise<void> {
  const doc = win.document;
  if (!doc?.createElement) return Promise.resolve();
  return new Promise((resolve) => {
    const script = doc.createElement("script");
    script.src = `./config.js?r=${Date.now()}`;
    script.onload = script.onerror = () => {
      script.remove();
      resolve();
    };
    doc.head.appendChild(script);
  });
}

export function createHostBridge(
  win: HostWindow,
  fetchFn: typeof fetch = fetch.bind(win),
  { reload = reloadConfig, waitMs = STARTUP_WAIT_MS }: { readonly reload?: (w: HostWindow) => Promise<void>; readonly waitMs?: number } = {},
): Bridge | null {
  const send = win.chrome?.send;
  let config = readConfig(win);
  if (typeof send !== "function") return null;

  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<Listener>>();
  let next = 0;

  const emit = (event: string, data: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(data);
  };

  win.cr = {
    ...win.cr,
    webUIResponse(id: string, isSuccess: boolean, response: unknown) {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (isSuccess) {
        waiter.resolve(response);
      } else {
        const r = (response ?? {}) as { code?: unknown; message?: unknown };
        waiter.reject(new HostError(typeof r.message === "string" ? r.message : "Perch couldn't do that", typeof r.code === "string" ? r.code : "error"));
      }
    },
    webUIListenerCallback(name: string, event: unknown, data: unknown) {
      if (name === "perch-event" && typeof event === "string") emit(event, data);
    },
  };

  const callBrowser = (method: string, args: readonly unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = `perch-${++next}`;
      pending.set(id, { resolve, reject });
      send.call(win.chrome, "perch.call", [id, method, [...args]]);
    });

  const post = (c: AppConfig, method: string, args: readonly unknown[]) =>
    fetchFn(`${c.api}/api/pages/${encodeURIComponent(method)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });

  /** The call, waiting for perchd while it starts: config.js is read again until it names a perchd that answers. */
  const reach = async (method: string, args: readonly unknown[]): Promise<Response> => {
    const until = Date.now() + waitMs;
    for (;;) {
      if (config) {
        try {
          return await post(config, method, args);
        } catch {
          // Not up yet, or it restarted on another port.
        }
      }
      if (Date.now() >= until) throw new HostError(UNREACHABLE, "unavailable");
      await new Promise((r) => win.setTimeout(r, RETRY_MS));
      await reload(win);
      const fresh = readConfig(win);
      if (fresh && (fresh.api !== config?.api || fresh.token !== config?.token)) {
        config = fresh;
        if (!socket && [...listeners.values()].some((s) => s.size > 0)) connect();
      }
    }
  };

  const callPerchd = async (method: string, args: readonly unknown[]) => {
    const res = await reach(method, args);
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (!res.ok) {
      const message = typeof body?.error === "string" ? body.error : "Perch couldn't do that. Try again.";
      throw new HostError(message, res.status === 404 || res.status === 501 ? "unavailable" : "error");
    }
    return body;
  };

  let socket: WebSocket | null = null;
  const connect = () => {
    const Socket = win.WebSocket;
    if (socket || !config || typeof Socket !== "function") return;
    const ws = new Socket(`${config.api.replace(/^http/, "ws")}/ws`, ["perch-app", `token.${config.token}`]);
    socket = ws;
    ws.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type?: unknown; event?: unknown; data?: unknown };
        if (msg.type === "pages.event" && typeof msg.event === "string") emit(msg.event, msg.data);
      } catch {
        // Not an event for pages.
      }
    });
    ws.addEventListener("close", () => {
      socket = null;
      if ([...listeners.values()].some((s) => s.size > 0)) win.setTimeout(connect, 2000);
    });
  };

  return {
    call: (method, args) => (BROWSER_METHODS.has(method) ? callBrowser(method, args) : callPerchd(method, args)),
    subscribe(event, listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      if (event !== "appearance") connect();
      return () => {
        set.delete(listener);
      };
    },
  };
}

/** Installs `window.perch` when the page runs inside Perch. */
export function installHostBridge(win: HostWindow): boolean {
  if (win.perch) return true;
  const bridge = createHostBridge(win);
  if (!bridge) return false;
  win.perch = bridge;
  return true;
}
