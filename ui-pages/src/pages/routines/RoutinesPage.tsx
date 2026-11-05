import { useEffect, useState } from "preact/hooks";
import type { Routine, RoutineProposal, RoutineRun } from "../../api";
import { describeSchedule } from "../../lib/labels";
import { relativeTime, shortDateTime } from "../../lib/time";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Icon, Pencil, Play, Plus, Repeat, Trash2 } from "../../ui/icons";
import { Switch } from "../../ui/Switch";
import { RoutineEditor } from "./RoutineEditor";
import "./routines.css";

const OUTCOME: Readonly<Record<RoutineRun["outcome"], string>> = { ok: "finished", failed: "failed", waiting: "is waiting for your approval" };

function runLine(r: Routine): string {
  const parts = [r.lastRun ? `Last run ${OUTCOME[r.lastRun.outcome]}, ${shortDateTime(r.lastRun.at)}` : "Hasn't run yet"];
  if (r.enabled && r.nextRun) parts.push(`next ${relativeTime(r.nextRun).toLowerCase()}`);
  return parts.join(" · ");
}

function Proposals({ items, onAccept, onDismiss }: { readonly items: readonly RoutineProposal[]; readonly onAccept: (p: RoutineProposal) => void; readonly onDismiss: (p: RoutineProposal) => void }) {
  return (
    <section class="rt-sec" aria-labelledby="found-h">
      <h2 id="found-h" class="rt-sec-h">Tasks you repeat</h2>
      {items.length === 0 ? (
        <p class="mute" role="status">Nothing else to suggest right now. Perch looks again as you browse.</p>
      ) : (
        <ul class="rt-list">
          {items.map((p) => (
            <li key={p.id} class="rt sug">
              <div class="rt-main">
                <h3>{p.title}</h3>
                <p class="cap"><span class="mono">{describeSchedule(p.schedule)}</span> · <span>{p.evidence}</span></p>
                <p class="rt-prompt">{p.prompt}</p>
              </div>
              <div class="rt-act">
                <button type="button" class="btn" aria-label={`Not now: ${p.title}`} onClick={() => onDismiss(p)}>Not now</button>
                <button type="button" class="btn primary" aria-label={`Add ${p.title}`} onClick={() => onAccept(p)}>Add routine</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** perch://routines: saved tasks that run on a schedule (spec 8). */
export function RoutinesPage() {
  const api = useApi();
  const act = useAction();
  const routines = useLoad((a) => a.listRoutines());
  const [proposals, setProposals] = useState<readonly RoutineProposal[] | null>(null);
  const [editing, setEditing] = useState<{ routine: Routine | null } | null>(null);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const list = routines.data ?? [];
  const replace = (r: Routine) => routines.set(list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [...list, r]);

  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id || !routines.data) return;
    const el = document.getElementById(`rt-${id}`);
    el?.scrollIntoView?.({ block: "center" });
    el?.classList.add("hit");
  }, [routines.data !== undefined]);

  const find = async () => {
    const found = await act(() => api.findRoutineProposals());
    if (found) setProposals(found);
  };

  return (
    <main class="rt-page">
      <div class="rt-wrap">
        <div class="rt-top">
          <h1>Routines</h1>
          <span class="grow" />
          <button type="button" class="btn" onClick={find}><Icon of={Repeat} />Find routines to automate</button>
          <button type="button" class="btn primary" onClick={() => setEditing({ routine: null })}><Icon of={Plus} />New routine</button>
        </div>
        <p class="mute rt-lead">Routines run a task on a schedule with your default permission mode. Anything that sends, posts or pays still waits for you.</p>

        {proposals && (
          <Proposals
            items={proposals}
            onAccept={async (p) => {
              const r = await act(() => api.acceptProposal(p.id), `Added ${p.title}`);
              if (r) {
                replace(r);
                setProposals(proposals.filter((x) => x.id !== p.id));
              }
            }}
            onDismiss={async (p) => {
              await act(() => api.dismissProposal(p.id));
              setProposals(proposals.filter((x) => x.id !== p.id));
            }}
          />
        )}

        <section class="rt-sec" aria-labelledby="mine-h">
          <h2 id="mine-h" class="rt-sec-h">Your routines</h2>
          {routines.error && <p class="err-note">{routines.error}</p>}
          {routines.data && list.length === 0 && (
            <div class="rt-empty">
              <p class="serif-title">No routines yet</p>
              <p class="mute">Make one yourself, or let Perch look for tasks you've done at least twice in the last 30 days.</p>
            </div>
          )}
          <ul class="rt-list">
            {list.map((r) => (
              <li key={r.id} id={`rt-${r.id}`} class="rt">
                <div class="rt-main">
                  <h3>{r.title}</h3>
                  <p class="cap">
                    <span class="mono">{describeSchedule(r.schedule)}</span>
                    {!r.enabled && <> · <span>Paused</span></>}
                  </p>
                  <p class="rt-prompt">{r.prompt}</p>
                  <p class={`cap ${r.lastRun?.outcome === "failed" ? "err-note" : ""}`}>{runLine(r)}</p>
                </div>
                <div class="rt-act">
                  <button type="button" class="ib" aria-label={`Run ${r.title} now`} onClick={async () => {
                    if (await act(() => api.runRoutine(r.id).then(() => true), `Started ${r.title}`)) routines.reload();
                  }}><Icon of={Play} /></button>
                  <button type="button" class="ib" aria-label={`Edit ${r.title}`} onClick={() => setEditing({ routine: r })}><Icon of={Pencil} /></button>
                  <button type="button" class="ib" aria-label={`Delete ${r.title}`} onClick={() => setDeleting(r)}><Icon of={Trash2} /></button>
                  <Switch label={`Run ${r.title} on schedule`} checked={r.enabled} onChange={async (enabled) => {
                    const next = await act(() => api.setRoutineEnabled(r.id, enabled), enabled ? `${r.title} is on` : `Paused ${r.title}`);
                    if (next) replace(next);
                  }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <RoutineEditor
        open={editing !== null}
        routine={editing?.routine ?? null}
        onClose={() => setEditing(null)}
        onSaved={(r) => {
          setEditing(null);
          replace(r);
        }}
      />
      <Dialog open={deleting !== null} title={deleting ? `Delete ${deleting.title}?` : ""} onClose={() => setDeleting(null)} footer={deleting && <>
        <button type="button" class="btn" onClick={() => setDeleting(null)}>Cancel</button>
        <button type="button" class="btn primary danger" onClick={async () => {
          const r = deleting;
          setDeleting(null);
          if (await act(() => api.deleteRoutine(r.id).then(() => true), `Deleted ${r.title}`)) routines.set(list.filter((x) => x.id !== r.id));
        }}>Delete routine</button>
      </>}>
        <p>The routine stops and its schedule is removed. Chats it already ran stay in your history.</p>
      </Dialog>
    </main>
  );
}
