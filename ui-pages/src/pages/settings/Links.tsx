/** Settings sections that summarise a full page and link to it: Memory, Routines and Import. */

import { useState } from "preact/hooks";
import type { MemorySettings } from "../../api";
import { describeSchedule } from "../../lib/labels";
import { inlineTime } from "../../lib/time";
import { MANAGED_NOTE } from "../../lib/managed";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { useManaged } from "../../ui/useManaged";
import { Dialog } from "../../ui/Dialog";
import { Group, LinkRow, Row } from "../../ui/Row";
import { Switch } from "../../ui/Switch";
import { BrowserIcon } from "../import/ImportSteps";
import { DreamLogDialog } from "./DreamLogDialog";

export function MemorySection() {
  const api = useApi();
  const act = useAction();
  const settings = useLoad((a) => a.getMemorySettings());
  const { locked } = useManaged();
  const [wiping, setWiping] = useState(false);
  const [reading, setReading] = useState(false);
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
          <Row id="memory-extraction" title="Learn from chats" detail={locked("memory-extraction") ? MANAGED_NOTE : "After each chat, your Fast model saves lasting facts to memory"}>
            <Switch label="Learn from chats" describedBy="memory-extraction-d" checked={s.extraction} disabled={locked("memory-extraction")} onChange={(extraction) => patch({ extraction })} />
          </Row>
          <Row id="dreaming" title="Tidy memory overnight" detail={locked("dreaming") ? MANAGED_NOTE : s.lastDream ? `Files daily notes into lasting pages, merges duplicates and moves old facts to history. Last ran ${inlineTime(s.lastDream)}.` : "Files daily notes into lasting pages, merges duplicates and moves old facts to history"}>
            <Switch label="Tidy memory overnight" describedBy="dreaming-d" checked={s.dreaming} disabled={locked("dreaming")} onChange={(dreaming) => patch({ dreaming })} />
          </Row>
          <Row id="daily-notes" title="Keep daily notes" detail="Notes from chats that the overnight tidy hasn't filed yet">
            <select class="picker" aria-label="Keep daily notes" value={String(s.episodicRetentionDays ?? "always")}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                void patch({ episodicRetentionDays: v === "always" ? null : (Number(v) as 30 | 90) });
              }}>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="always">Always</option>
            </select>
          </Row>
          <Row id="dream-log" sub title="Overnight tidy log" detail="What each pass merged, updated and moved, by date">
            <button type="button" class="btn" onClick={() => setReading(true)}>Read the log</button>
          </Row>
        </div>
        <p class="note">Memory stays on this Mac, encrypted. Incognito windows never read or write it.</p>
      </Group>
      <Group label="Manage">
        <div class="card">
          <LinkRow title="Open Memory" detail="Browse, edit and delete anything Perch remembers" onClick={() => act(() => api.openPage("memory"))} />
          <LinkRow title="Set up your memory" detail="Build a profile from the sources you pick, then review it" onClick={() => act(() => api.openPage("memory", "setup"))} />
        </div>
        <div class="card">
          <Row id="memory-wipe" title="Delete all memory" detail="Removes every memory page on this Mac. This can't be undone.">
            <button type="button" class="btn danger" onClick={() => setWiping(true)}>Delete all</button>
          </Row>
        </div>
      </Group>
      <DreamLogDialog open={reading} onClose={() => setReading(false)} />
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
      <Group label="Routines" id="routines-list" bare>
        <div class="card">
          {routines.data && list.length === 0 && <p class="empty">No routines yet. Open Routines to set one up.</p>}
          {list.map((r) => (
            <Row key={r.id} title={r.title} detail={describeSchedule(r.schedule)}>
              <Switch label={`Run ${r.title}`} checked={r.enabled} onChange={async (enabled) => {
                const next = await act(() => api.setRoutineEnabled(r.id, enabled));
                if (next) routines.set(list.map((x) => (x.id === r.id ? next : x)));
              }} />
            </Row>
          ))}
        </div>
        <div class="card">
          <LinkRow title="Open Routines" detail="Add, edit or find routines to automate" onClick={() => act(() => api.openPage("routines"))} />
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
  const { locked } = useManaged();
  const list = browsers.data ?? [];
  return (
    <div class="sec">
      <Group label="Browsers on this Mac" id="import-browsers">
        <div class="card">
          {browsers.data && list.length === 0 && <p class="empty">No other browsers found on this Mac.</p>}
          {list.map((b) => (
            <Row key={b.id} title={b.name} detail={b.profiles.map((p) => p.name).join(", ")} icon={<BrowserIcon browser={b} />}>
              <button type="button" class="btn" aria-label={`Import from ${b.name}`} onClick={() => act(() => api.openPage("import", b.id))}>Import</button>
            </Row>
          ))}
        </div>
        <p class="note">Tabs open asleep and load when you click them, so a large import doesn't slow the Mac down.</p>
        {locked("import-browsers") && <p class="note">Your organization chooses which browsers and data you can import.</p>}
      </Group>
    </div>
  );
}
