import { useEffect, useState } from "preact/hooks";
import type { DraftFact, JobId, SetupSource } from "../../api";
import { errorText, useAction, useApi, useLoad } from "../../ui/frame";
import { Progress } from "../../ui/Progress";
import { Switch } from "../../ui/Switch";
import { useJob } from "../../ui/useJob";
import { FactReview } from "./FactReview";

type Outcome = { readonly kind: "saved"; readonly count: number } | { readonly kind: "discarded" } | null;

/**
 * "Set up your memory" (spec 8): the person picks sources, Perch builds a draft profile, and
 * every fact can be edited or removed before "Save to memory". Nothing is saved until then.
 */
export function SetupMemory({ onOpenMemory }: { readonly onOpenMemory: () => void }) {
  const api = useApi();
  const act = useAction();
  const sources = useLoad((a) => a.listSetupSources());
  const [on, setOn] = useState<readonly string[] | null>(null);
  const [jobId, setJobId] = useState<JobId | null>(null);
  const [draft, setDraft] = useState<readonly DraftFact[]>([]);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useJob(jobId);
  const list: readonly SetupSource[] = sources.data ?? [];
  const chosen = on ?? list.filter((s) => s.on && s.available).map((s) => s.id);
  const building = progress?.state === "running";

  useEffect(() => {
    if (progress?.state === "done") api.getProfileDraft().then(setDraft, (e) => setError(errorText(e)));
    if (progress?.state === "failed") setError(progress.error ?? "The build stopped. Try again.");
  }, [progress?.state]);

  const build = async () => {
    setOutcome(null);
    setError(null);
    setDraft([]);
    const id = await act(() => api.startProfileBuild(chosen));
    if (id) setJobId(id);
  };
  const save = async () => {
    const r = await act(() => api.saveProfileDraft(draft));
    if (r) {
      setDraft([]);
      setOutcome({ kind: "saved", count: r.saved });
    }
  };
  const discard = async () => {
    await act(() => api.discardProfileDraft());
    setDraft([]);
    setOutcome({ kind: "discarded" });
  };

  return (
    <div class="mem">
      <div>
        <h1 class="serif-title" tabIndex={-1}>Set up your memory</h1>
        <p class="lead">
          Perch reads the sources you switch on and drafts a profile, so it can write in your voice, fill forms and know who people are.
          You review every fact before anything is saved. Memory stays on this Mac, encrypted.
        </p>
      </div>
      <div class="mem-grid">
        <section class="panel" aria-labelledby="src-h">
          <div class="panel-h"><h2 id="src-h">Sources</h2><span class="cap">{`${chosen.length} of ${list.length} on`}</span></div>
          <ul class="src-list">
            {list.map((s) => (
              <li key={s.id} class="src">
                <div>
                  <div class="n" id={`src-${s.id}`}>{s.name}</div>
                  <div class="d" id={`src-${s.id}-d`}>{s.detail}</div>
                </div>
                <Switch
                  label={s.name}
                  describedBy={`src-${s.id}-d`}
                  checked={chosen.includes(s.id)}
                  disabled={!s.available || building}
                  onChange={(v) => setOn(v ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))}
                />
              </li>
            ))}
          </ul>
          <div class="panel-f">
            <button type="button" class="btn primary" disabled={building || chosen.length === 0} onClick={build}>
              {draft.length ? "Build again" : "Build my profile"}
            </button>
            <span class="note">Takes a few minutes. You can keep browsing.</span>
          </div>
        </section>

        <section class="panel" aria-labelledby="learned-h">
          <div class="panel-h">
            <h2 id="learned-h">What Perch learned</h2>
            <span class="cap">{draft.length ? `Draft · ${draft.length} facts` : ""}</span>
          </div>
          {building && progress && <Progress progress={progress} label="Building your profile" />}
          {error && <p class="empty err-note" role="alert">{error}</p>}
          {!building && draft.length === 0 && !outcome && !error && (
            <p class="empty">Turn on the sources you want, then build your profile. Nothing is saved until you review it.</p>
          )}
          {outcome?.kind === "saved" && (
            <div class="empty done-note">
              <p role="status">Saved {outcome.count} facts to memory. You can change them any time on the Memory page.</p>
              <button type="button" class="btn" onClick={onOpenMemory}>Open memory</button>
            </div>
          )}
          {outcome?.kind === "discarded" && <p class="empty" role="status">Draft discarded. Nothing was saved.</p>}
          {!building && draft.length > 0 && (
            <>
              <FactReview facts={draft} onChange={setDraft} />
              <div class="panel-f">
                <button type="button" class="btn primary" onClick={save}>Save to memory</button>
                <button type="button" class="btn" onClick={discard}>Discard</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
