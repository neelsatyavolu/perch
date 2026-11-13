import { useEffect, useState } from "preact/hooks";
import type { DraftFact, FileChoice, JobId, SetupSource } from "../../api";
import { errorText, useAction, useApi, useLoad } from "../../ui/frame";
import { Progress } from "../../ui/Progress";
import { useJob } from "../../ui/useJob";
import { FactReview } from "./FactReview";
import { SourceList } from "./SourceList";
import { BUILD_MEMORY_PROMPT } from "./build-prompt";

type Outcome = { readonly kind: "saved"; readonly count: number } | { readonly kind: "discarded" } | null;

/**
 * "Set up your memory" (spec 8): the person picks sources, Perch builds a draft profile, and
 * every fact can be edited or removed before "Save to memory". Nothing is saved until then.
 * The build runs in perchd, so leaving or reloading the page picks up where it was: a running
 * build is followed again and a finished draft is shown for review.
 */
export function SetupMemory({ onOpenMemory }: { readonly onOpenMemory: () => void }) {
  const api = useApi();
  const act = useAction();
  const sources = useLoad((a) => a.listSetupSources());
  const [on, setOn] = useState<readonly string[] | null>(null);
  const [files, setFiles] = useState<Readonly<Record<string, FileChoice>>>({});
  const [jobId, setJobId] = useState<JobId | null>(null);
  const [draft, setDraft] = useState<readonly DraftFact[]>([]);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useJob(jobId);
  const list: readonly SetupSource[] = sources.data ?? [];
  const chosen = on ?? list.filter((s) => s.on && s.available && s.needs !== "export-file").map((s) => s.id);
  const building = progress?.state === "running" || (jobId !== null && progress === null);

  useEffect(() => {
    let live = true;
    api.getProfileBuild().then((id) => live && id && setJobId(id), () => undefined);
    api.getProfileDraft().then((d) => live && d.length > 0 && setDraft(d), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (progress?.state === "done") api.getProfileDraft().then(setDraft, (e) => setError(errorText(e)));
    if (progress?.state === "failed") setError(progress.error ?? "The build stopped. Try again.");
  }, [progress?.state]);

  const chooseFile = async (s: SetupSource): Promise<boolean> => {
    const picked = await act(() => api.chooseFile("memory-export"));
    if (!picked) return false;
    setFiles((f) => ({ ...f, [s.id]: picked }));
    return true;
  };
  const toggle = async (s: SetupSource, value: boolean) => {
    if (value && s.needs === "export-file" && !files[s.id] && !(await chooseFile(s))) return;
    setOn(value ? [...chosen.filter((x) => x !== s.id), s.id] : chosen.filter((x) => x !== s.id));
  };
  const openFullDiskAccess = async () => {
    await act(() => api.openFullDiskAccess());
    window.addEventListener("focus", () => sources.reload(), { once: true });
  };
  const build = async () => {
    setOutcome(null);
    setError(null);
    setDraft([]);
    const ids = Object.fromEntries(chosen.filter((id) => files[id]).map((id) => [id, files[id]!.id]));
    const id = await act(() => api.startProfileBuild(chosen, ids));
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
        <p class="note">
          For a fuller profile, <button type="button" class="link-btn" onClick={() => act(() => api.submitQuery({ text: BUILD_MEMORY_PROMPT, mode: "ask", engine: "brave" }))}>let Perch research you in a chat</button>: it reads your email, accounts and AI services the way you would, and what it finds lands here for review.
        </p>
      </div>
      <div class="mem-grid">
        <section class="panel" aria-labelledby="src-h">
          <div class="panel-h"><h2 id="src-h">Sources</h2><span class="cap">{`${chosen.length} of ${list.length} on`}</span></div>
          <SourceList sources={list} chosen={chosen} files={files} disabled={building}
            onToggle={toggle} onChooseFile={chooseFile} onOpenFullDiskAccess={openFullDiskAccess} />
          <div class="panel-f">
            <button type="button" class="btn primary" disabled={building || chosen.length === 0} onClick={build}>
              {draft.length ? "Build again" : "Build my profile"}
            </button>
            <span class="note">Takes a few minutes. You can keep browsing or close this tab; the draft waits here.</span>
          </div>
        </section>

        <section class="panel" aria-labelledby="learned-h">
          <div class="panel-h">
            <h2 id="learned-h">What Perch learned</h2>
            <span class="cap">{draft.length ? `Draft · ${draft.length} facts` : ""}</span>
          </div>
          {building && (progress ? <Progress progress={progress} label="Building your profile" /> : <p class="empty" role="status">Starting the build</p>)}
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
