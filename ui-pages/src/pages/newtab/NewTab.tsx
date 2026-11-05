import { useEffect, useState } from "preact/hooks";
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
  const [data, setData] = useState<Data>({ chats: [], routines: [], suggestions: [] });

  const refresh = () =>
    Promise.all([api.listChats(12), api.listRoutines(), api.listSuggestions()]).then(
      ([chats, routines, suggestions]) => setData({ chats, routines, suggestions }),
      () => undefined,
    );

  useEffect(() => {
    api.getNtpLayout().then(setLayout, () => setLayout({ railOpen: true, hidden: [], recentTab: "chats" }));
    refresh();
    // The page is reused when the tab comes back; suggestions may have finished in the meantime.
    const onShow = () => document.visibilityState !== "hidden" && refresh();
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
      {layout.railOpen && <ChatRail chats={data.chats} />}
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
          {!layout.hidden.includes("recent") && (
            <Recent chats={data.chats} routines={data.routines} tab={layout.recentTab} onTab={(recentTab) => update({ recentTab })} onHide={() => hide("recent")} />
          )}
          {!layout.hidden.includes("suggested") && <Suggested items={data.suggestions} onHide={() => hide("suggested")} onDismissed={() => refresh()} />}
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
