import { useEffect, useRef, useState } from "preact/hooks";
import type { DetectedBrowser, FileChoice, ImportKind, ImportNeed, JobId, SystemAccess } from "../../api";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Progress } from "../../ui/Progress";
import { useJob } from "../../ui/useJob";
import { ASIDE_KINDS, BrowserStep, DataStep, importPlan, kindList, PermissionStep } from "./ImportSteps";
import "./import.css";

type Step = "browser" | "data" | "access" | "run";
const STEPS: readonly { id: Step; label: string }[] = [
  { id: "browser", label: "Browser" }, { id: "data", label: "What to bring" }, { id: "access", label: "Permissions" }, { id: "run", label: "Import" },
];

const defaultKinds = (b: DetectedBrowser): readonly ImportKind[] => b.options.filter((o) => o.available).map((o) => o.kind);

export type ImportStatus = "idle" | "running" | "done";

type Props = {
  /** Inside another page (the welcome screen): no <main>, an h3 title, no Done button, and the URL
      hash is ignored. */
  readonly embedded?: boolean;
  /** Told when an import starts running and when one finishes. */
  readonly onStatus?: (status: ImportStatus) => void;
};

/** The import wizard (spec 10), also the first-run import step. */
export function ImportWizard({ embedded = false, onStatus }: Props) {
  const api = useApi();
  const act = useAction();
  const browsers = useLoad((a) => a.detectBrowsers());
  const [step, setStep] = useState<Step>("browser");
  const [browser, setBrowser] = useState<DetectedBrowser | null>(null);
  /** The profiles to import, in the order the browser lists them; the first is picked to start. */
  const [profiles, setProfiles] = useState<readonly string[]>([]);
  const [kinds, setKinds] = useState<readonly ImportKind[]>([]);
  const [access, setAccess] = useState<SystemAccess | null>(null);
  const [csv, setCsv] = useState<FileChoice | null>(null);
  const [safariExport, setSafariExport] = useState<FileChoice | null>(null);
  const [jobId, setJobId] = useState<JobId | null>(null);
  const progress = useJob(jobId);
  const heading = useRef<HTMLHeadingElement>(null);
  // Set once the person picks a browser, so the automatic pick below never overrides theirs.
  const picked = useRef(false);

  const choose = (b: DetectedBrowser) => {
    setBrowser(b);
    setProfiles(b.profiles[0] ? [b.profiles[0].id] : []);
    setKinds(defaultKinds(b));
    setCsv(null);
    setSafariExport(null);
  };

  // perch://import#chrome opens on that browser's data step; otherwise the one used most recently
  // (the list comes in that order) starts picked.
  useEffect(() => {
    const list = browsers.data;
    if (!list?.length) return;
    const found = embedded ? undefined : list.find((b) => b.id === window.location.hash.slice(1));
    if (found) {
      choose(found);
      setStep("data");
    } else if (!picked.current) choose(list[0]!);
  }, [browsers.data]);

  const go = (s: Step) => {
    setStep(s);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const needs: readonly ImportNeed[] = browser
    ? [...new Set(browser.options.filter((o) => kinds.includes(o.kind) && o.needs).map((o) => o.needs!))]
    : [];
  // Whatever lacks its file or permission stays behind, and everything else comes over.
  const plan = browser
    ? importPlan({ browser, kinds, csv: Boolean(csv), safariExport: Boolean(safariExport), fullDiskAccess: access?.fullDiskAccess ?? null })
    : { sent: kinds, left: [] };
  const sent = plan.sent;
  const start = async () => {
    if (!browser) return;
    setJobId(null);
    // A chosen file goes only with what needs it still ticked; unticking on the way back drops it.
    const passwordsCsv = needs.includes("csv-export") ? csv?.id : undefined;
    const exportId = needs.includes("safari-export") ? safariExport?.id : undefined;
    const ordered = browser.profiles.map((p) => p.id).filter((p) => profiles.includes(p));
    const id = await act(() => api.startImport({
      browser: browser.id, profile: ordered[0] ?? "", ...(ordered.length > 1 ? { profiles: ordered } : {}), kinds: sent,
      ...(passwordsCsv ? { passwordsCsv } : {}), ...(exportId ? { safariExport: exportId } : {}),
    }));
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
  const back = () => {
    if (step === "run") {
      setJobId(null);
      return go("data");
    }
    go(step === "access" ? "data" : "browser");
  };
  const restart = () => {
    setJobId(null);
    setBrowser(null);
    go("browser");
  };
  const at = STEPS.findIndex((s) => s.id === step);
  const done = progress?.state === "done";
  const failed = progress?.state === "failed";
  const running = step === "run" && !done && !failed;
  useEffect(() => onStatus?.(done ? "done" : running ? "running" : "idle"), [done, running]);
  // Coming back from System Settings, the Full Disk Access line shows what was turned on there.
  useEffect(() => {
    if (step !== "access") return;
    const recheck = async () => setAccess((await api.getSystemAccess().catch(() => null)) ?? access);
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [step, access]);
  const Wrap = embedded ? "div" : "main";
  const Title = embedded ? "h3" : "h1";
  // Embedded, the host page's heading and step dots already say where you are; the title stays for
  // screen readers and focus, and shows only to report the outcome.
  const titleClass = embedded && !done && !failed ? "sr-only" : undefined;
  const ownBack = step === "data" || step === "access" || failed;
  const backClass = embedded ? "btn quiet" : "btn";
  const hasFoot = step !== "run" || failed || done;

  return (
    <Wrap class={embedded ? "imp imp-embedded" : "imp-page"}>
      <div class="imp">
        <Title ref={heading} class={titleClass} tabIndex={-1}>{done ? "Import finished" : failed ? "Import stopped" : "Import from another browser"}</Title>
        <ol class="steps-ol" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={i === at ? "step" : undefined} class={i < at ? "past" : ""}>{s.label}</li>
          ))}
        </ol>
        <section class="panel imp-body">
          {browsers.error && <p class="err-note">{browsers.error}</p>}
          {step === "browser" && browsers.data && (
            <BrowserStep browsers={browsers.data} browser={browser} profiles={profiles} onBrowser={(b) => { picked.current = true; choose(b); }}
              onToggleProfile={(id) => setProfiles((x) => (x.includes(id) ? x.filter((p) => p !== id) : [...x, id]))} />
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
            <PermissionStep browser={browser} needs={needs} access={access} csv={csv} safariExport={safariExport} left={plan.left} canGoAhead={sent.length > 0}
              onChooseCsv={async () => setCsv(await act(() => api.chooseFile("passwords-csv")) ?? csv)}
              onChooseSafariExport={async () => setSafariExport(await act(() => api.chooseFile("safari-export")) ?? safariExport)}
              onRestart={() => act(() => api.restartPerch())}
              onOpenSettings={async () => {
                await act(() => api.openFullDiskAccess());
                setAccess(await act(() => api.getSystemAccess()) ?? access);
              }} />
          )}
          {step === "run" && !progress && <p class="mute" role="status">Starting the import</p>}
          {step === "run" && progress?.state === "running" && <Progress progress={progress} label={`Importing from ${browser?.name ?? ""}`} />}
          {step === "run" && failed && (
            <p class="err-note" role="alert">{progress.error ?? "The import stopped."} Anything imported before that point was kept.</p>
          )}
          {done && (
            <ul class="summary" aria-label="Imported">
              {(progress.summary ?? []).map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
        </section>
        {hasFoot && (
          <div class="imp-foot">
            {ownBack && <button type="button" class={backClass} onClick={back}>Back</button>}
            <span class="grow" />
            {step === "browser" && browsers.data && browsers.data.length > 0 && <button type="button" class={embedded ? "btn" : "btn primary"} disabled={!browser || profiles.length === 0} onClick={next}>Continue</button>}
            {step === "data" && <button type="button" class={embedded ? "btn" : "btn primary"} disabled={kinds.length === 0} onClick={next}>Continue</button>}
            {step === "access" && (
              <button type="button" class={embedded ? "btn" : "btn primary"} disabled={sent.length === 0} onClick={next}>
                {plan.left.length > 0 && sent.length > 0 ? `Import without ${kindList(plan.left)}` : "Start import"}
              </button>
            )}
            {failed && <button type="button" class={embedded ? "btn" : "btn primary"} onClick={start}>Try again</button>}
            {done && (
              <>
                <button type="button" class="btn" onClick={restart}>Import from another browser</button>
                {!embedded && <button type="button" class="btn primary" onClick={() => act(() => api.openPage("newtab"))}>Done</button>}
              </>
            )}
          </div>
        )}
      </div>
    </Wrap>
  );
}
