import { useEffect, useState } from "preact/hooks";
import type { Routine, RoutineInput, Schedule, TriggerEvent, Weekday } from "../../api";
import { TRIGGERS, TRIGGER_EVENTS, WEEKDAYS } from "../../lib/labels";
import { checkTime, checkTitle, checkTrigger } from "../../lib/validate";
import { errorText, useApi } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { Segmented } from "../../ui/Segmented";

type Kind = Schedule["kind"];
type Draft = { title: string; prompt: string; kind: Kind; days: readonly Weekday[]; time: string; hours: string; event: TriggerEvent; match: string };

const BLANK: Draft = {
  title: "", prompt: "", kind: "daily", days: ["mon", "tue", "wed", "thu", "fri"], time: "08:00", hours: "12", event: "mail-received", match: "",
};

function fromRoutine(r: Routine): Draft {
  const s = r.schedule;
  return {
    ...BLANK, title: r.title, prompt: r.prompt,
    ...(s.kind === "daily" ? { kind: "daily", days: s.days, time: s.time }
      : s.kind === "interval" ? { kind: "interval", hours: String(s.hours) }
      : { kind: "trigger", event: s.event, match: s.match ?? "" }),
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
  const matchField = TRIGGERS[d.event].match;

  const save = async () => {
    const title = checkTitle(d.title);
    if (!title.ok) return setError({ field: "title", text: title.error });
    if (!d.prompt.trim()) return setError({ field: "prompt", text: "Say what the routine should do" });
    let schedule: Schedule;
    if (d.kind === "trigger") {
      const t = checkTrigger(d.event, matchField ? d.match : undefined);
      if (!t.ok) return setError({ field: "match", text: t.error });
      schedule = t.value;
    } else if (d.kind === "daily") {
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
      <div class="label">
        <span>When</span>
        {/* Perch can't start a routine on an event yet, so only a routine that already has one shows the choice. */}
        <Segmented<Kind> label="When" value={d.kind} onChange={(kind) => edit({ kind })} options={[
          { value: "daily", label: "On days at a time" }, { value: "interval", label: "Every few hours" },
          ...(routine?.schedule.kind === "trigger" ? [{ value: "trigger" as const, label: "When something happens" }] : []),
        ]} />
      </div>
      {d.kind === "daily" && (
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
      )}
      {d.kind === "interval" && (
        <Field label="Hours between runs" error={err("hours")}>
          {(a) => <input class="field mono time" type="number" min={1} max={168} value={d.hours} onInput={(e) => edit({ hours: (e.currentTarget as HTMLInputElement).value })} {...a} />}
        </Field>
      )}
      {d.kind === "trigger" && (
        <div class="sched">
          <Field label="What starts it">
            {(a) => (
              <select class="picker" value={d.event} onChange={(e) => edit({ event: (e.currentTarget as HTMLSelectElement).value as TriggerEvent })} {...a}>
                {TRIGGER_EVENTS.map((t) => <option key={t} value={t}>{TRIGGERS[t].label}</option>)}
              </select>
            )}
          </Field>
          {matchField && (
            <Field label={matchField.required ? matchField.label : `${matchField.label} (optional)`} error={err("match")}>
              {(a) => <input class={`field${d.event === "site-opened" ? " mono" : ""}`} value={d.match} placeholder={matchField.placeholder} onInput={(e) => edit({ match: (e.currentTarget as HTMLInputElement).value })} {...a} />}
            </Field>
          )}
        </div>
      )}
      {err("form") && <p class="field-error" role="alert">{err("form")}</p>}
    </Dialog>
  );
}
