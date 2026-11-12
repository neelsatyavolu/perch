import type { ChatStatus, ChatSummary, NtpLayout, Routine } from "../../api";
import { describeSchedule } from "../../lib/labels";
import { relativeTime } from "../../lib/time";
import { useAction, useApi } from "../../ui/frame";
import { TabList } from "../../ui/TabList";

/** The digits of a time or schedule in mono, the words around them in the caption face. */
const digits = (s: string) => s.split(/(\d[\d:]*)/).map((part, i) => (i % 2 ? <span key={i} class="mono">{part}</span> : part));

const STATUS: Readonly<Record<ChatStatus, string | null>> = { idle: null, running: "Working", waiting: "Waiting for your approval" };

type Props = {
  readonly chats: readonly ChatSummary[];
  readonly routines: readonly Routine[];
  readonly tab: NtpLayout["recentTab"];
  readonly onTab: (tab: NtpLayout["recentTab"]) => void;
  readonly onHide: () => void;
};

export function Recent({ chats, routines, tab, onTab, onHide }: Props) {
  const api = useApi();
  const act = useAction();
  return (
    <section class="ntp-sec" aria-label="Recent">
      <div class="sec-h">
        <TabList label="Recent" idPrefix="recent" value={tab} onChange={onTab} tabs={[{ value: "chats", label: "Chats" }, { value: "routines", label: "Routines" }]} />
        {tab === "routines" && (
          <button type="button" class="btn quiet sm all-btn" onClick={() => act(() => api.openPage("routines"))}>All routines</button>
        )}
        <button type="button" class="btn quiet sm hide-btn" aria-label="Hide recent" onClick={onHide}>Hide</button>
      </div>
      <div role="tabpanel" id={`recent-panel-${tab}`} aria-labelledby={`recent-tab-${tab}`} class="cards">
        {tab === "chats" &&
          (chats.length ? chats.slice(0, 3).map((c) => (
            <button type="button" key={c.id} class="ccard" onClick={() => act(() => api.openChat(c.id))}>
              <span class="when">
                <span class="w">{digits(relativeTime(c.updatedAt))}</span>
                {STATUS[c.status] && <><span aria-hidden="true">·</span><span>{STATUS[c.status]}</span></>}
              </span>
              <span class="tt">{c.title}</span>
              <span class="sn">{c.snippet}</span>
            </button>
          )) : <p class="cards-empty">No chats yet. Type a task above and press ⌘↵ to start one.</p>)}
        {tab === "routines" &&
          (routines.length ? routines.slice(0, 3).map((r) => (
            <button type="button" key={r.id} class="ccard" onClick={() => act(() => api.openPage("routines", r.id))}>
              <span class="when">
                <span class="w">{digits(describeSchedule(r.schedule))}</span>
                {!r.enabled && <><span aria-hidden="true">·</span><span>Paused</span></>}
              </span>
              <span class="tt">{r.title}</span>
              <span class="sn">{r.prompt}</span>
            </button>
          )) : <p class="cards-empty">No routines yet. Perch can look for tasks you repeat and offer to run them on a schedule.</p>)}
      </div>
    </section>
  );
}
