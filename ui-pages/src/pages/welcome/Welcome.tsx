import { useRef, useState } from "preact/hooks";
import type { OnboardingStep, Provider } from "../../api";
import { ACCENTS, ACCENT_NAMES, THEMES, THEME_NAMES } from "../../theme/tokens";
import { useAction, useApi, useAppearance, useLoad } from "../../ui/frame";
import { PerchMark } from "../../ui/PerchMark";
import { ImportWizard } from "../import/ImportWizard";
import { Swatches } from "../../ui/Swatches";
import "./welcome.css";

const ORDER: readonly OnboardingStep[] = ["appearance", "models", "import", "memory"];

function Look() {
  const { appearance: a, update } = useAppearance();
  const t = THEMES[a.theme];
  return (
    <div class="wl-grid">
      <div class="label"><span>Theme</span>
        <Swatches label="Theme" value={a.theme} onChange={(theme) => update({ theme })} options={THEME_NAMES.map((n) => ({ value: n, label: THEMES[n].label, bg: THEMES[n].card, fg: THEMES[n].ink }))} />
      </div>
      <div class="label"><span>Accent</span>
        <Swatches label="Accent" value={a.accent} onChange={(accent) => update({ accent })} options={ACCENT_NAMES.map((n) => ({ value: n, label: ACCENTS[n].label, bg: t.card, fg: t.dark ? ACCENTS[n].dark : ACCENTS[n].light }))} />
      </div>
      <p class="note">You can change both, or follow macOS light and dark, in Settings.</p>
    </div>
  );
}

function Models() {
  const api = useApi();
  const act = useAction();
  const providers = useLoad((a) => a.listProviders());
  const list = (providers.data ?? []).filter((p) => p.kind === "subscription");
  const replace = (p: Provider) => providers.set((providers.data ?? []).map((x) => (x.id === p.id ? p : x)));
  return (
    <div class="card">
      {list.map((p) => (
        <div class="srow noicon" key={p.id} id={`prov-${p.id}`}>
          <div><div class="n">{p.name}</div><div class="d">{p.detail}</div></div>
          <div class="ctl">
            {p.state === "connected" ? (
              <span class="status ok"><span class="dotc" />Connected{p.account ? ` · ${p.account}` : ""}</span>
            ) : (
              <button type="button" class="btn" aria-label={`Sign in to ${p.name}`} onClick={async () => { const r = await act(() => api.signIn(p.id)); if (r) replace(r); }}>Sign in</button>
            )}
          </div>
        </div>
      ))}
      <p class="empty">API keys and models on this Mac are in Settings, under Models.</p>
    </div>
  );
}

const COPY: Readonly<Record<OnboardingStep, { title: string; lead: string }>> = {
  appearance: { title: "Pick a look", lead: "Five themes and five accents. The pages you visit keep their own colours." },
  models: { title: "Connect a model", lead: "Perch's agent uses your own subscription. Claude runs through Claude Code on this Mac, which keeps its own sign-in." },
  import: { title: "Bring your tabs and bookmarks", lead: "Import from a browser on this Mac. Tabs open asleep, so a big import won't slow anything down." },
  memory: { title: "Set up your memory", lead: "Perch can learn about you from sources you pick, so you explain less. You review every fact before it's saved, and it stays on this Mac, encrypted." },
};

/** The first-run welcome screen. Every step can be skipped. */
export function Welcome() {
  const api = useApi();
  const act = useAction();
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focus = () => requestAnimationFrame(() => heading.current?.focus());

  const finish = async (page: "newtab" | "memory" = "newtab") => {
    await act(() => api.finishOnboarding());
    await act(() => api.openPage(page, page === "memory" ? "setup" : undefined));
  };
  const advance = async (completed: boolean) => {
    if (!step) return;
    if (completed) await act(() => api.completeOnboardingStep(step));
    const next = ORDER[ORDER.indexOf(step) + 1];
    if (next) {
      setStep(next);
      focus();
    } else await finish();
  };

  if (!step) {
    return (
      <main class="wl wl-hero">
        <PerchMark size={56} />
        <h1 class="serif-title" ref={heading} tabIndex={-1}>Welcome to Perch</h1>
        <p class="wl-lead">A browser with an agent that works on the sites you're signed in to. What it learns stays on this Mac, encrypted.</p>
        <div class="wl-actions">
          <button type="button" class="btn primary" onClick={() => { setStep("appearance"); focus(); }}>Set up Perch</button>
          <button type="button" class="btn quiet" onClick={() => finish()}>Skip setup</button>
        </div>
      </main>
    );
  }

  const index = ORDER.indexOf(step);
  return (
    <main class="wl">
      <p class="cap">Step {index + 1} of {ORDER.length}</p>
      <h1 class="serif-title" ref={heading} tabIndex={-1}>{COPY[step].title}</h1>
      <p class="wl-lead">{COPY[step].lead}</p>
      <div class="wl-body">
        {step === "appearance" && <Look />}
        {step === "models" && <Models />}
        {step === "import" && <ImportWizard embedded onFinished={() => advance(true)} />}
      </div>
      <div class="wl-actions">
        {step === "memory" ? (
          <>
            <button type="button" class="btn primary" onClick={async () => { await act(() => api.completeOnboardingStep("memory")); await finish("memory"); }}>Set up memory</button>
            <button type="button" class="btn quiet" onClick={() => advance(false)}>Not now</button>
          </>
        ) : step === "import" ? (
          <button type="button" class="btn quiet" onClick={() => advance(false)}>Skip import</button>
        ) : (
          <>
            <button type="button" class="btn primary" onClick={() => advance(true)}>Continue</button>
            {step !== "appearance" && <button type="button" class="btn quiet" onClick={() => advance(false)}>Skip</button>}
          </>
        )}
      </div>
    </main>
  );
}
