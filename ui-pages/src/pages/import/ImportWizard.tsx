import { useEffect, useRef, useState } from "preact/hooks";
import type { DetectedBrowser, ImportKind, ImportNeed, JobId, SystemAccess } from "../../api";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Progress } from "../../ui/Progress";
import { useJob } from "../../ui/useJob";
import { ASIDE_KINDS, BrowserStep, DataStep, PermissionStep } from "./ImportSteps";
import "./import.css";

type Step = "browser" | "data" | "access" | "run";
const STEPS: readonly { id: Step; label: string }[] = [
  { id: "browser", label: "Browser" }, { id: "data", label: "What to bring" }, { id: "access", label: "Permissions" }, { id: "run", label: "Import" },
];

const defaultKinds = (b: DetectedBrowser): readonly ImportKind[] => b.options.filter((o) => o.available).map((o) => o.kind);

/** The import wizard (spec 10), also the first-run import step. */
export function ImportWizard({ onFinished }: { readonly onFinished?: () => void }) {
  const api = useApi();
  const act = useAction();
  const browsers = useLoad((a) => a.detectBrowsers());
  const [step, setStep] = useState<Step>("browser");
  const [browser, setBrowser] = useState<DetectedBrowser | null>(null);
  const [profile, setProfile] = useState("");
  const [kinds, setKinds] = useState<readonly ImportKind[]>([]);
  const [access, setAccess] = useState<SystemAccess | null>(null);
  const [jobId, setJobId] = useState<JobId | null>(null);
  const progress = useJob(jobId);
  const heading = useRef<HTMLHeadingElement>(null);

  const choose = (b: DetectedBrowser) => {
    setBrowser(b);
    setProfile(b.profiles[0]?.id ?? "");
    setKinds(defaultKinds(b));
  };

  useEffect(() => {
    const id = window.location.hash.slice(1);
    const found = browsers.data?.find((b) => b.id === id);
    if (found) {
      choose(found);
      setStep("data");
    }
  }, [browsers.data]);

  const go = (s: Step) => {
    setStep(s);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const needs: readonly ImportNeed[] = browser
    ? [...new Set(browser.options.filter((o) => kinds.includes(o.kind) && o.needs).map((o) => o.needs!))]
    : [];
  const start = async () => {
    if (!browser) return;
    const id = await act(() => api.startImport({ browser: browser.id, profile, kinds }));
    if (id) {
      setJobId(id);
      go("run");
    }
  };
  const next = async () => {
    if (step === "browser") return go("data");
    if (step === "data") {
      if (needs.length === 0) return start();
      setAccess(await act(() => api.getSystemAccess()) ?? null);
      return go("access");
    }
    if (step === "access") return start();
  };
  const back = () => go(step === "access" ? "data" : "browser");
  const at = STEPS.findIndex((s) => s.id === step);
  const done = progress?.state === "done";

  return (
    <main class="imp-page">
      <div class="imp">
        <h1 ref={heading} tabIndex={-1}>{done ? "Import finished" : "Import from another browser"}</h1>
        <ol class="steps-ol" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={i === at ? "step" : undefined} class={i < at ? "past" : ""}>{s.label}</li>
          ))}
        </ol>
        <section class="panel imp-body">
          {browsers.error && <p class="err-note">{browsers.error}</p>}
          {step === "browser" && browsers.data && (
            <BrowserStep browsers={browsers.data} browser={browser} profile={profile} onBrowser={choose} onProfile={setProfile} />
          )}
          {step === "data" && browser && (
            <>
              <DataStep browser={browser} kinds={kinds} onToggle={(k) => setKinds((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]))} />
              <p class="note">Tabs open asleep and load when you click them, so a large import doesn't slow the Mac down.</p>
              {browser.options.some((o) => ASIDE_KINDS.includes(o.kind)) && (
                <p class="note">Model sign-ins are not copied. You sign in again in Settings, so tokens never move between apps.</p>
              )}
            </>
          )}
          {step === "access" && browser && (
            <PermissionStep browser={browser} needs={needs} access={access} onOpenSettings={async () => {
              await act(() => api.openFullDiskAccess());
              setAccess(await act(() => api.getSystemAccess()) ?? access);
            }} />
          )}
          {step === "run" && progress && !done && <Progress progress={progress} label={`Importing from ${browser?.name ?? ""}`} />}
          {step === "run" && progress?.state === "failed" && <p class="err-note" role="alert">{progress.error ?? "The import stopped. Nothing after the last step was imported."}</p>}
          {done && (
            <ul class="summary" aria-label="Imported">
              {(progress.summary ?? []).map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
        </section>
        <div class="imp-foot">
          {(step === "data" || step === "access") && <button type="button" class="btn" onClick={back}>Back</button>}
          <span class="grow" />
          {step === "browser" && <button type="button" class="btn primary" disabled={!browser} onClick={next}>Continue</button>}
          {step === "data" && <button type="button" class="btn primary" disabled={kinds.length === 0} onClick={next}>Continue</button>}
          {step === "access" && <button type="button" class="btn primary" onClick={next}>Start import</button>}
          {done && (
            <>
              <button type="button" class="btn" onClick={() => { setJobId(null); setBrowser(null); go("browser"); }}>Import from another browser</button>
              <button type="button" class="btn primary" onClick={() => (onFinished ? onFinished() : act(() => api.openPage("newtab")))}>Done</button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
