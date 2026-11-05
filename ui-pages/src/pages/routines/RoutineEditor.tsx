import { useEffect, useState } from "preact/hooks";
import type { Routine, RoutineInput, Schedule, Weekday } from "../../api";
import { WEEKDAYS } from "../../lib/labels";
import { checkTime, checkTitle } from "../../lib/validate";
import { errorText, useApi } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { Segmented } from "../../ui/Segmented";

type Kind = "daily" | "interval";
type Draft = { title: string; prompt: string; kind: Kind; days: readonly Weekday[]; time: string; hours: string };

const BLANK: Draft = { title: "", prompt: "", kind: "daily", days: ["mon", "tue", "wed", "thu", "fri"], time: "08:00", hours: "12" };

function fromRoutine(r: Routine): Draft {
  const s = r.schedule;
  return {
    ...BLANK, title: r.title, prompt: r.prompt,
    ...(s.kind === "daily" ? { kind: "daily", days: s.days, time: s.time } : s.kind === "interval" ? { kind: "interval", hours: String(s.hours) } : {}),
  };
}

type Props = { readonly open: boolean; readonly routine: Routine | null; readonly onClose: () => void; readonly onSaved: (r: Routine) => void };

export function RoutineEditor({ open, routine, onClose, onSaved }: Props) {
  const api = useApi();
  const [d, setD] = useState<Draft>(BLANK);
  const [error, setError] = useState<{ field: string; text: string } | null>(null);
  useEffect(() => {
    if (open) {
      setD(routine ? fromRoutine(routine) : BLANK);
      setError(null);
    }
  }, [open, routine?.id]);
  const edit = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const err = (field: string) => (error?.field === field ? error.text : null);
  const trigger = routine?.schedule.kind === "trigger";

  const save = async () => {
    const title = checkTitle(d.title);
    if (!title.ok) return setError({ field: "title", text: title.error });
    if (!d.prompt.trim()) return setError({ field: "prompt", text: "Say what the routine should do" });
    let schedule: Schedule;
    if (trigger && routine) schedule = routine.schedule;
    else if (d.kind === "daily") {
      if (d.days.length === 0) return setError({ field: "days", text: "Pick at least one day" });
      const time = checkTime(d.time);
      if (!time.ok) return setError({ field: "time", text: time.error });
      schedule = { kind: "daily", time: time.value, days: WEEKDAYS.map((w) => w.id).filter((w) => d.days.includes(w)) };
    } else {
      const hours = Number(d.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) return setError({ field: "hours", text: "Pick between 1 and 168 hours" });
      schedule = { kind: "interval", hours };
    }
    const input: RoutineInput = { id: routine?.id, title: title.value, prompt: d.prompt.trim(), schedule };
    try {
      onSaved(await api.saveRoutine(input));
    } catch (e) {
      setError({ field: "form", text: errorText(e) });
    }
  };

  return (
    <Dialog open={open} title={routine ? "Edit routine" : "New routine"} onClose={onClose} footer={<>
      <button type="button" class="btn" onClick={onClose}>Cancel</button>
      <button type="button" class="btn primary" onClick={save}>Save routine</button>
    </>}>
      <Field label="Name" error={err("title")}>
        {(a) => <input class="field" value={d.title} placeholder="Morning mail summary" onInput={(e) => edit({ title: (e.currentTarget as HTMLInputElement).value })} {...a} />}
      </Field>
      <Field label="What Perch should do" hint="Write it as you would ask in a chat. It runs with your default permission mode." error={err("prompt")}>
        {(a) => <textarea class="field" value={d.prompt} placeholder="Summarise new mail from my teachers, grouped by what needs a reply" onInput={(e) => edit({ prompt: (e.currentTarget as HTMLTextAreaElement).value })} {...a} />}
      </Field>
      {trigger ? (
        <p class="note">This routine runs when {routine?.schedule.kind === "trigger" ? routine.schedule.event : ""}. Its trigger can't be changed here.</p>
      ) : (
        <>
          <div class="label">
            <span>When</span>
            <Segmented<Kind> label="When" value={d.kind} onChange={(kind) => edit({ kind })} options={[{ value: "daily", label: "On days at a time" }, { value: "interval", label: "Every few hours" }]} />
          </div>
          {d.kind === "daily" ? (
            <div class="sched">
              <div class="label">
                <span id="days-l">Days</span>
                <div class="days" role="group" aria-labelledby="days-l" aria-describedby={err("days") ? "days-err" : undefined}>
                  {WEEKDAYS.map((w) => {
                    const on = d.days.includes(w.id);
                    return (
                      <button key={w.id} type="button" class="day" aria-label={w.long} aria-pressed={on ? "true" : "false"}
                        onClick={() => edit({ days: on ? d.days.filter((x) => x !== w.id) : [...d.days, w.id] })}>
                        {w.short}
                      </button>
                    );
                  })}
                </div>
                {err("days") && <span class="field-error" id="days-err" role="alert">{err("days")}</span>}
              </div>
              <Field label="Time" error={err("time")}>
                {(a) => <input class="field mono time" type="time" value={d.time} onInput={(e) => edit({ time: (e.currentTarget as HTMLInputElement).value })} {...a} />}
              </Field>
            </div>
          ) : (
            <Field label="Hours between runs" error={err("hours")}>
              {(a) => <input class="field mono time" type="number" min={1} max={168} value={d.hours} onInput={(e) => edit({ hours: (e.currentTarget as HTMLInputElement).value })} {...a} />}
            </Field>
          )}
        </>
      )}
      {err("form") && <p class="field-error" role="alert">{err("form")}</p>}
    </Dialog>
  );
}
