import { useState } from "preact/hooks";
import type { MemorySaverSettings, SleepRule, TabMemory } from "../../api";
import { SLEEP_RULES, sleepRuleText } from "../../lib/labels";
import { MANAGED_NOTE } from "../../lib/managed";
import { errorText, useAction, useApi, useLoad } from "../../ui/frame";
import { useManaged } from "../../ui/useManaged";
import { Icon, Trash2 } from "../../ui/icons";
import { Group, Row } from "../../ui/Row";
import { Switch } from "../../ui/Switch";

const TIMEOUTS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "Off" },
  { minutes: 5, label: "5 minutes" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 240, label: "4 hours" },
];

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function TabMemoryCard() {
  const tabs = useLoad((a) => a.listTabMemory());
  const list: readonly TabMemory[] = [...(tabs.data ?? [])].sort((a, b) => b.bytes - a.bytes);
  const total = list.reduce((sum, t) => sum + t.bytes, 0);
  return (
    <Group label="Memory by tab" id="tab-memory">
      <div class="card">
        {tabs.data && list.length === 0 && <p class="empty">No tabs are open.</p>}
        {list.map((t, i) => (
          <Row key={`${t.url}-${i}`} title={<span class="tab-title" title={t.title}>{t.title}</span>}>
            {t.asleep ? <span class="mute">Asleep</span> : <span class="mono">{mb(t.bytes)}</span>}
          </Row>
        ))}
      </div>
      <div class="tab-memory-foot">
        <p class="note">{tabs.error ?? "Sleeping tabs use no memory. They reload when you click them."}</p>
        {list.length > 0 && <span class="tab-total">Total <span class="mono">{mb(total)}</span></span>}
        <button type="button" class="btn" onClick={tabs.reload}>Refresh</button>
      </div>
    </Group>
  );
}

/** Memory saver (spec 5.6): one setting, the sites it leaves alone, and what each tab uses. */
export function Performance() {
  const api = useApi();
  const act = useAction();
  const saver = useLoad((a) => a.getMemorySaver());
  const { locked } = useManaged();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const s = saver.data;
  const apply = async (run: () => Promise<MemorySaverSettings>, done?: string) => {
    const next = await act(run, done);
    if (next) saver.set(next);
  };
  if (!s) return <p class="mute">{saver.error ?? ""}</p>;
  const isLocked = locked("memory-saver");

  const add = async () => {
    try {
      const next = await api.addSleepRule(input);
      saver.set(next);
      setError(null);
      setInput("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const remove = (rule: SleepRule) => {
    const text = sleepRuleText(rule);
    apply(() => api.setMemorySaver({ rules: s.rules.filter((r) => r !== rule) }), `${text} can sleep again`);
  };
  const known = TIMEOUTS.some((t) => t.minutes === s.timeoutMinutes);

  return (
    <div class="sec">
      <Group label="Memory saver">
        <div class="card">
          <Row id="memory-saver" title="Sleep tabs you aren't using" detail={isLocked ? MANAGED_NOTE : "A tab you haven't looked at for this long stops using memory. It wakes when you click it"}>
            <select class="picker" aria-label="Sleep tabs after" aria-describedby="memory-saver-d" value={String(s.timeoutMinutes)} disabled={isLocked}
              onChange={(e) => {
                const minutes = Number((e.currentTarget as HTMLSelectElement).value);
                const label = TIMEOUTS.find((t) => t.minutes === minutes)?.label ?? "";
                apply(() => api.setMemorySaver({ timeoutMinutes: minutes }), minutes === 0 ? "Tabs stay awake" : `Tabs sleep after ${label}`);
              }}>
              {!known && <option value={String(s.timeoutMinutes)}>{s.timeoutMinutes} minutes</option>}
              {TIMEOUTS.map((t) => <option key={t.minutes} value={String(t.minutes)}>{t.label}</option>)}
            </select>
          </Row>
          <Row id="sleep-pinned" title="Sleep pinned tabs" detail="Pinned tabs can sleep like any other tab">
            <Switch label="Sleep pinned tabs" describedBy="sleep-pinned-d" checked={s.sleepPinned ?? false} disabled={isLocked}
              onChange={(sleepPinned) => apply(() => api.setMemorySaver({ sleepPinned }), sleepPinned ? "Pinned tabs can sleep" : "Pinned tabs stay awake")} />
          </Row>
        </div>
        <p class="note">Tabs playing sound, in picture-in-picture, sharing your screen or holding unsent form text stay awake.</p>
      </Group>

      <Group label="Never sleep these sites" id="never-sleep">
        <div class="card">
          {s.rules.length === 0 && <p class="empty">No sites. Every tab can sleep.</p>}
          {s.rules.map((r) => {
            const text = sleepRuleText(r);
            return (
              <Row key={`${r.kind}:${r.pattern}`} title={<span class="mono">{r.kind === "host" ? text.replace(/^=/, "") : text}</span>} detail={SLEEP_RULES[r.kind]}>
                <button type="button" class="ib" aria-label={`Remove ${text}`} disabled={isLocked} onClick={() => remove(r)}>
                  <Icon of={Trash2} />
                </button>
              </Row>
            );
          })}
          <form class="add-rule" style={{ gridTemplateColumns: "1fr auto" }} onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input class="field mono" aria-label="Site to keep awake" placeholder="example.com, *.example.com or =mail.example.com" value={input}
              disabled={isLocked} aria-invalid={error ? "true" : undefined} aria-describedby={error ? "never-sleep-err" : undefined}
              onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)} />
            <button type="submit" class="btn" disabled={isLocked}>Add</button>
            {error && <p class="field-error" id="never-sleep-err" role="alert">{error}</p>}
          </form>
        </div>
        {isLocked && <p class="note">{MANAGED_NOTE}</p>}
      </Group>

      <TabMemoryCard />
    </div>
  );
}
