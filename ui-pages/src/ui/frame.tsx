/**
 * The frame every page renders in: finds the backend, applies the appearance (and keeps
 * following macOS and the browser's appearance changes), and gives the page its API, appearance
 * and a status line for announcements.
 */

import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Appearance, PerchApi } from "../api";
import { loadApi } from "../api/resolve";
import { isBridge } from "../api/rpc";
import { DEFAULT_APPEARANCE, applyAppearance, cacheAppearance, isAppearance, readSystemPrefs, watchSystemPrefs } from "../theme/apply";
import { CircleAlert, Icon, X } from "./icons";

type AppearanceCtx = { readonly appearance: Appearance; readonly update: (patch: Partial<Appearance>) => Promise<void> };
type Announce = (message: string, tone?: "polite" | "error") => void;

const ApiContext = createContext<PerchApi | null>(null);
const AppearanceContext = createContext<AppearanceCtx>({ appearance: DEFAULT_APPEARANCE, update: async () => undefined });
const AnnounceContext = createContext<Announce>(() => undefined);

export function useApi(): PerchApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi outside PageFrame");
  return api;
}
export const useAppearance = () => useContext(AppearanceContext);
export const useAnnounce = () => useContext(AnnounceContext);

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The one download location the project controls. perchbrowser.com is not registered yet (spec, line 9). */
export const RELEASES_URL = "https://github.com/neelsatyavolu/perch/releases";

/** How long the toast takes to fade out (frame.css), before its message is cleared. */
const TOAST_EXIT_MS = 180;

type FrameProps = { readonly children: ComponentChildren; readonly api?: PerchApi | null; readonly title?: string };

export function PageFrame({ children, api: injected, title }: FrameProps) {
  const [api, setApi] = useState<PerchApi | null | undefined>(injected);
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [status, setStatus] = useState<{ text: string; tone: "polite" | "error"; on: boolean }>({ text: "", tone: "polite", on: false });
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (title) document.title = title;
    if (injected !== undefined) return;
    loadApi(window).then(setApi, () => setApi(null));
  }, []);

  const paint = useCallback((a: Appearance) => {
    applyAppearance(document.documentElement, a, readSystemPrefs(window));
    const s = storage();
    if (s) cacheAppearance(a, s);
  }, []);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.getAppearance().then((a) => {
      if (!live) return;
      setAppearance(a);
      paint(a);
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [api]);

  // The browser sends "appearance" whenever the theme or accent changes, from any page or the
  // toolbar, so every open page repaints with the chrome (as the sidebar does, ui/src/host).
  useEffect(() => {
    if (!api) return;
    const bridge = (window as Window & { perch?: unknown }).perch;
    if (!isBridge(bridge)) return;
    return bridge.subscribe("appearance", (data) => {
      if (!isAppearance(data)) return;
      setAppearance(data);
      paint(data);
    });
  }, [api]);

  useEffect(() => watchSystemPrefs(window, () => paint(appearance)), [appearance]);

  // The toast fades out with its message in place, then empties, so the same message is read again next time.
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setStatus((s) => ({ ...s, on: false }));
    timer.current = setTimeout(() => setStatus((s) => ({ ...s, text: "" })), TOAST_EXIT_MS);
  }, []);

  const announce = useCallback<Announce>((text, tone = "polite") => {
    clearTimeout(timer.current);
    setStatus({ text, tone, on: true });
    timer.current = setTimeout(hide, tone === "error" ? 8000 : 4000);
  }, []);

  const appearanceCtx = useMemo<AppearanceCtx>(() => ({
    appearance,
    update: async (patch) => {
      if (!api) return;
      const optimistic = { ...appearance, ...patch };
      setAppearance(optimistic);
      paint(optimistic);
      try {
        const saved = await api.setAppearance(patch);
        setAppearance(saved);
        paint(saved);
      } catch (e) {
        setAppearance(appearance);
        paint(appearance);
        announce(errorText(e), "error");
      }
    },
  }), [api, appearance]);

  if (api === undefined) return <div class="frame-msg" aria-busy="true" />;
  if (api === null) {
    return (
      <main class="frame-msg">
        <h1>Perch's background service isn't running</h1>
        <p>This page needs it to load your settings. Quit Perch and open it again. If that doesn't help, download Perch again from its releases page, <span class="mono">{RELEASES_URL}</span>, and reinstall it.</p>
      </main>
    );
  }
  return (
    <ApiContext.Provider value={api}>
      <AppearanceContext.Provider value={appearanceCtx}>
        <AnnounceContext.Provider value={announce}>
          {children}
          <div class={`toast ${status.on ? "on" : ""} ${status.tone}`}>
            {status.tone === "error" && <Icon of={CircleAlert} />}
            <span class="toast-t" role={status.tone === "error" ? "alert" : "status"} aria-live={status.tone === "error" ? "assertive" : "polite"}>
              {status.text}
            </span>
            {status.tone === "error" && (
              <button type="button" class="ib sm" aria-label="Dismiss" onClick={hide}>
                <Icon of={X} />
              </button>
            )}
          </div>
        </AnnounceContext.Provider>
      </AppearanceContext.Provider>
    </ApiContext.Provider>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Perch couldn't finish that. Try again.";
}

/** Loads data from the API; `set` replaces it after a change, `reload` fetches again. */
export function useLoad<T>(load: (api: PerchApi) => Promise<T>, deps: readonly unknown[] = []) {
  const api = useApi();
  const [state, setState] = useState<{ data: T | undefined; error: string | null }>({ data: undefined, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    load(api).then(
      (data) => live && setState({ data, error: null }),
      (e) => live && setState({ data: undefined, error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, n, ...deps]);
  return {
    data: state.data,
    error: state.error,
    set: (data: T) => setState({ data, error: null }),
    reload: () => setN((x) => x + 1),
  };
}

/** Runs a change, announces failures in plain words, and returns the result or undefined. */
export function useAction() {
  const announce = useAnnounce();
  return useCallback(async <T,>(run: () => Promise<T>, done?: string): Promise<T | undefined> => {
    try {
      const result = await run();
      if (done) announce(done);
      return result;
    } catch (e) {
      announce(errorText(e), "error");
      return undefined;
    }
  }, [announce]);
}
