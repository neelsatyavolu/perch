/** Settings sections that summarise a full page and link to it: Memory, Routines and Import. */

import { useState } from "preact/hooks";
import type { MemorySettings } from "../../api";
import { describeSchedule } from "../../lib/labels";
import { relativeTime } from "../../lib/time";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Group, Row } from "../../ui/Row";
import { Switch } from "../../ui/Switch";

export function MemorySection() {
  const api = useApi();
  const act = useAction();
  const settings = useLoad((a) => a.getMemorySettings());
  const [wiping, setWiping] = useState(false);
  const s = settings.data;
  const patch = async (x: Partial<MemorySettings>) => {
    const next = await act(() => api.setMemorySettings(x));
    if (next) settings.set(next);
  };
  if (!s) return <p class="mute">{settings.error ?? ""}</p>;
  return (
    <div class="sec">
      <Group label="What Perch remembers">
        <div class="card">
          <Row id="memory-extraction" title="Learn from chats" detail="After each chat, your Fast model saves lasting facts to memory">
            <Switch label="Learn from chats" describedBy="memory-extraction-d" checked={s.extraction} onChange={(extraction) => patch({ extraction })} />
          </Row>
          <Row id="history-extraction" title="Learn from browsing history" detail="Notes which sites you use for what. Runs on this Mac on a schedule.">
            <Switch label="Learn from browsing history" describedBy="history-extraction-d" checked={s.historyExtraction} onChange={(historyExtraction) => patch({ historyExtraction })} />
          </Row>
          <Row id="dreaming" title="Tidy memory overnight" detail={s.lastDream ? `Merges duplicates and moves old facts to history. Last ran ${relativeTime(s.lastDream).toLowerCase()}.` : "Merges duplicates and moves old facts to history"}>
            <Switch label="Tidy memory overnight" describedBy="dreaming-d" checked={s.dreaming} onChange={(dreaming) => patch({ dreaming })} />
          </Row>
        </div>
        <p class="note">Memory stays on this Mac, encrypted. Incognito windows never read or write it.</p>
      </Group>
      <Group label="Manage">
        <div class="card">
          <Row title="Memory page" detail="Browse, edit and delete anything Perch remembers">
            <button type="button" class="btn" onClick={() => act(() => api.openPage("memory"))}>Open memory</button>
          </Row>
          <Row title="Set up your memory" detail="Build a profile from the sources you pick, then review it">
            <button type="button" class="btn" onClick={() => act(() => api.openPage("memory", "setup"))}>Set up</button>
          </Row>
          <Row id="memory-wipe" title="Delete all memory" detail="Removes every memory page on this Mac. This can't be undone.">
            <button type="button" class="btn danger" onClick={() => setWiping(true)}>Delete all</button>
          </Row>
        </div>
      </Group>
      <Dialog
        open={wiping}
        title="Delete all memory?"
        onClose={() => setWiping(false)}
        footer={<>
          <button type="button" class="btn" onClick={() => setWiping(false)}>Cancel</button>
          <button type="button" class="btn primary danger" onClick={async () => { setWiping(false); await act(() => api.wipeMemory(), "Deleted all memory"); }}>Delete all memory</button>
        </>}
      >
        <p>Perch will forget everything it learned about you, the people you know and the sites you use. Chats stay.</p>
      </Dialog>
    </div>
  );
}

export function RoutinesSection() {
  const api = useApi();
  const act = useAction();
  const routines = useLoad((a) => a.listRoutines());
  const list = routines.data ?? [];
  return (
    <div class="sec">
      <Group label="Routines" id="routines-list">
        <div class="card">
          {routines.data && list.length === 0 && <p class="empty">No routines yet.</p>}
          {list.map((r) => (
            <Row key={r.id} title={r.title} detail={describeSchedule(r.schedule)}>
              <Switch label={`Run ${r.title}`} checked={r.enabled} onChange={async (enabled) => {
                const next = await act(() => api.setRoutineEnabled(r.id, enabled));
                if (next) routines.set(list.map((x) => (x.id === r.id ? next : x)));
              }} />
            </Row>
          ))}
          <button type="button" class="more-row" onClick={() => act(() => api.openPage("routines"))}>Open Routines to add, edit or find routines</button>
        </div>
        <p class="note">Routines run with your default permission mode and appear in the activity log under Permissions.</p>
      </Group>
    </div>
  );
}

export function ImportSection() {
  const api = useApi();
  const act = useAction();
  const browsers = useLoad((a) => a.detectBrowsers());
  const list = browsers.data ?? [];
  return (
    <div class="sec">
      <Group label="Browsers on this Mac" id="import-browsers">
        <div class="card">
          {browsers.data && list.length === 0 && <p class="empty">No other browsers found on this Mac.</p>}
          {list.map((b) => (
            <Row key={b.id} title={b.name} detail={b.profiles.map((p) => p.name).join(", ")} icon={<span class="tile" aria-hidden="true">{b.name.charAt(0)}</span>}>
              <button type="button" class="btn" aria-label={`Import from ${b.name}`} onClick={() => act(() => api.openPage("import", b.id))}>Import</button>
            </Row>
          ))}
        </div>
        <p class="note">Tabs open asleep and load when you click them, so a large import doesn't slow the Mac down.</p>
      </Group>
    </div>
  );
}
