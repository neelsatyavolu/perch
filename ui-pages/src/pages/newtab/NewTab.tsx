import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatSummary, NtpLayout, NtpSection, Routine, Suggestion } from "../../api";
import { useAction, useApi } from "../../ui/frame";
import { Icon, PanelLeft, PanelLeftClose } from "../../ui/icons";
import { PerchMark } from "../../ui/PerchMark";
import { AddressBox } from "./AddressBox";
import { ChatRail } from "./ChatRail";
import { Recent } from "./Recent";
import { Suggested } from "./Suggested";
import "./newtab.css";

type Data = { chats: readonly ChatSummary[]; routines: readonly Routine[]; suggestions: readonly Suggestion[] };
const SECTION_NAMES: Readonly<Record<NtpSection, string>> = { recent: "recent", suggested: "suggested" };

/** The new tab page (spec 5.5, DESIGN.md "New tab page"). No greeting headline. */
export function NewTab() {
  const api = useApi();
  const act = useAction();
  const [layout, setLayout] = useState<NtpLayout | null>(null);
  // Null until the lists first load: the page never says "No chats yet" to someone who has chats.
  const [data, setData] = useState<Data | null>(null);
  /** The refresh started by the tab coming back, so focus and visibilitychange run it once. */
  const showing = useRef<Promise<unknown> | null>(null);

  const refresh = () =>
    Promise.all([api.listChats(200), api.listRoutines(), api.listSuggestions()]).then(
      ([chats, routines, suggestions]) => setData({ chats, routines, suggestions }),
      () => undefined,
    );

  useEffect(() => {
    api.getNtpLayout().then(setLayout, () => setLayout({ railOpen: true, hidden: [], recentTab: "chats" }));
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

  if (!layout) return <main class="ntp-wrap" aria-busy="true" />;

  const update = (patch: Partial<NtpLayout>) => {
    setLayout({ ...layout, ...patch });
    act(() => api.setNtpLayout(patch));
  };
  const hide = (s: NtpSection) => update({ hidden: [...layout.hidden.filter((h) => h !== s), s] });
  const show = (s: NtpSection) => update({ hidden: layout.hidden.filter((h) => h !== s) });

  return (
    <div class="ntp-wrap">
      {layout.railOpen && <ChatRail chats={data?.chats ?? null} />}
      <main class="ntp-main">
        <button
          type="button"
          class="ib rail-toggle"
          aria-label={layout.railOpen ? "Hide chats" : "Show chats"}
          aria-expanded={layout.railOpen ? "true" : "false"}
          aria-controls="chat-rail"
          onClick={() => update({ railOpen: !layout.railOpen })}
        >
          <Icon of={layout.railOpen ? PanelLeftClose : PanelLeft} />
        </button>
        <div class="ntp">
          <h1 class="sr-only">New tab</h1>
          <PerchMark />
          <AddressBox onSubmit={(q) => act(() => api.submitQuery(q))} />
          {data && !layout.hidden.includes("recent") && (
            <Recent chats={data.chats} routines={data.routines} tab={layout.recentTab} onTab={(recentTab) => update({ recentTab })} onHide={() => hide("recent")} />
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
