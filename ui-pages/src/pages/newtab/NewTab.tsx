import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatSummary, NtpLayout, NtpSection, Routine, Suggestion } from "../../api";
import { useAction, useApi } from "../../ui/frame";
import { Icon, PanelLeft, PanelLeftClose } from "../../ui/icons";
import { PerchMark } from "../../ui/PerchMark";
import { Branch, Petals } from "../../ui/Sakura";
import { AddressBox } from "./AddressBox";
import { ChatRail } from "./ChatRail";
import { Recent } from "./Recent";
import { Suggested } from "./Suggested";
import "./newtab.css";

type Data = { chats: readonly ChatSummary[]; routines: readonly Routine[]; suggestions: readonly Suggestion[] };
const SECTION_NAMES: Readonly<Record<NtpSection, string>> = { recent: "recent", suggested: "suggested" };
/** Matches newtab.css: below this width the rail becomes a drawer over the page. */
const NARROW = "(max-width: 760px)";

const LAYOUT_KEY = "perch.ntpLayout";
const DEFAULT_LAYOUT: NtpLayout = { railOpen: true, hidden: [], recentTab: "chats" };

function isLayout(v: unknown): v is NtpLayout {
  const l = v as Partial<NtpLayout> | null;
  return (
    typeof l?.railOpen === "boolean" &&
    Array.isArray(l.hidden) && l.hidden.every((h) => Object.hasOwn(SECTION_NAMES, h)) &&
    (l.recentTab === "chats" || l.recentTab === "routines")
  );
}

/**
 * The last layout, kept in this profile's storage so the page draws at once, before perchd answers
 * (it can take seconds while Perch starts). Not secret; a bad or missing copy gives the defaults.
 */
export function readCachedLayout(): NtpLayout {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? "null");
    return isLayout(v) ? v : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** A layout edit, as a function of the layout it applies to (see `pending` in NewTab). */
type LayoutChange = (layout: NtpLayout) => Partial<NtpLayout>;
const apply = (layout: NtpLayout, change: LayoutChange): NtpLayout => ({ ...layout, ...change(layout) });

function cacheLayout(layout: NtpLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // No storage: the next page waits for nothing worse than the defaults.
  }
}

function useMedia(query: string): boolean {
  const mq = typeof matchMedia === "function" ? matchMedia(query) : null;
  const [matches, setMatches] = useState(() => mq?.matches ?? false);
  useEffect(() => {
    if (!mq) return;
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The new tab page (spec 5.5, DESIGN.md "New tab page"). No greeting headline. */
export function NewTab() {
  const api = useApi();
  const act = useAction();
  const [layout, setLayout] = useState<NtpLayout>(readCachedLayout);
  /**
   * Changes made before perchd's saved layout arrives. The cached copy they were shown on may be
   * stale, so they're replayed on the saved layout when it comes and only then sent; null once loaded.
   */
  const pending = useRef<LayoutChange[] | null>([]);
  const shown = useRef(layout);
  shown.current = layout;
  // Null until the lists first load: the page never says "No chats yet" to someone who has chats.
  const [data, setData] = useState<Data | null>(null);
  /** The refresh started by the tab coming back, so focus and visibilitychange run it once. */
  const showing = useRef<Promise<unknown> | null>(null);
  // At narrow widths the rail is a drawer that starts closed; the saved setting is for wide windows.
  const narrow = useMedia(NARROW);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // The drawer covers the page, so it takes focus while open: it starts on the search field, Tab
  // cycles through the drawer and its toggle, and closing it puts focus back on the toggle.
  useEffect(() => {
    if (!drawer) return;
    const rail = () => document.getElementById("chat-rail");
    rail()?.querySelector<HTMLElement>("input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawer(false);
      } else if (e.key === "Tab") {
        const stops = [toggleRef.current, ...(rail()?.querySelectorAll<HTMLElement>("input, button") ?? [])].filter((x): x is HTMLElement => x !== null);
        const at = stops.indexOf(document.activeElement as HTMLElement);
        if (stops.length === 0) return;
        e.preventDefault();
        stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (rail()?.contains(document.activeElement) || document.activeElement === document.body) toggleRef.current?.focus();
    };
  }, [drawer]);

  const refresh = () =>
    Promise.all([api.listChats(200), api.listRoutines(), api.listSuggestions()]).then(
      ([chats, routines, suggestions]) => setData({ chats, routines, suggestions }),
      () => undefined,
    );

  useEffect(() => {
    // Saved layout plus anything changed meanwhile; if perchd can't say, what's on screen stands.
    const settle = (base: NtpLayout | null) => {
      const queued = pending.current ?? [];
      pending.current = null;
      const next = base ? queued.reduce(apply, base) : shown.current;
      setLayout(next);
      cacheLayout(next);
      if (queued.length) act(() => api.setNtpLayout(next));
    };
    api.getNtpLayout().then(settle, () => settle(null));
    refresh();
    // The page is reused when the tab comes back; suggestions may have finished in the meantime.
    const onShow = () => {
      if (document.visibilityState === "hidden" || showing.current) return;
      showing.current = refresh().finally(() => (showing.current = null));
    };
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);

  const update = (change: LayoutChange) => {
    const next = apply(layout, change);
    setLayout(next);
    if (pending.current) {
      pending.current = [...pending.current, change];
      return;
    }
    cacheLayout(next);
    act(() => api.setNtpLayout(change(layout)));
  };
  const hide = (s: NtpSection) => update((l) => ({ hidden: [...l.hidden.filter((h) => h !== s), s] }));
  const show = (s: NtpSection) => update((l) => ({ hidden: l.hidden.filter((h) => h !== s) }));
  const railOpen = narrow ? drawer : layout.railOpen;
  const toggleRail = () => (narrow ? setDrawer(!drawer) : update((l) => ({ railOpen: !l.railOpen })));

  return (
    <div class="ntp-wrap">
      <Petals />
      {railOpen && narrow && <div class="rail-scrim" aria-hidden="true" onClick={() => setDrawer(false)} />}
      {railOpen && <ChatRail chats={data?.chats ?? null} drawer={narrow} />}
      <main class="ntp-main">
        <Branch />
        <div class="ntp-bar">
          <button
            ref={toggleRef}
            type="button"
            class="ib rail-toggle"
            aria-label={railOpen ? "Hide chats" : "Show chats"}
            aria-expanded={railOpen ? "true" : "false"}
            aria-controls="chat-rail"
            onClick={toggleRail}
          >
            <Icon of={railOpen ? PanelLeftClose : PanelLeft} />
          </button>
        </div>
        <div class="ntp">
          <h1 class="sr-only">New tab</h1>
          <PerchMark />
          <AddressBox onSubmit={(q) => act(() => api.submitQuery(q))} />
          {data && !layout.hidden.includes("recent") && (
            <Recent chats={data.chats} routines={data.routines} tab={layout.recentTab} onTab={(recentTab) => update(() => ({ recentTab }))} onHide={() => hide("recent")} />
          )}
          {data && !layout.hidden.includes("suggested") && <Suggested items={data.suggestions} onHide={() => hide("suggested")} onDismissed={() => refresh()} />}
          {layout.hidden.length > 0 && (
            <p class="hidden-note">
              {layout.hidden.map((s) => (
                <button type="button" key={s} class="btn quiet sm" onClick={() => show(s)}>
                  Show {SECTION_NAMES[s]}
                </button>
              ))}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
