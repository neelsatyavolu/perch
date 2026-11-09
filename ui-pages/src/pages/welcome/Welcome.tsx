import type preact from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { OnboardingStep, Provider } from "../../api";
import { ACCENTS, ACCENT_NAMES, THEMES, THEME_NAMES } from "../../theme/tokens";
import { errorText, useAction, useApi, useAppearance, useLoad } from "../../ui/frame";
import { PerchMark } from "../../ui/PerchMark";
import { ProviderMark } from "../../ui/ProviderMark";
import { ImportWizard } from "../import/ImportWizard";
import { RestoreForm } from "../settings/Backup";
import { Swatches } from "../../ui/Swatches";
import { createSound, type Sound } from "./sound";
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
        <div class="srow" key={p.id} id={`prov-${p.id}`}>
          <ProviderMark id={p.id} />
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
  import: { title: "Bring everything over", lead: "Windows and tabs, bookmarks, history, passwords, extensions, and the cookies that keep you signed in. Each window comes over as its own window, with its tabs asleep until you click them." },
  memory: { title: "Set up your memory", lead: "Perch can learn about you from sources you pick, so you explain less. You review every fact before it's saved, and it stays on this Mac, encrypted." },
};

/**
 * The welcome page fills the window: on first run Perch hides the tab strip and toolbar while it
 * shows, leaving only the window's own buttons at the top left, which the bar keeps clear of.
 */
type Mute = { readonly muted: boolean; readonly toggle: () => void };

function Stage({ step, mute, children }: { readonly step?: number; readonly mute?: Mute; readonly children: preact.ComponentChildren }) {
  return (
    <div class="wl-stage">
      <header class="wl-top">
        <span class="wl-brand"><PerchMark size={20} />Perch</span>
        {step !== undefined && (
          <>
            <ol class="wl-dots" aria-hidden="true">{ORDER.map((id, i) => <li key={id} class={i < step ? "done" : i === step ? "on" : ""} />)}</ol>
            <p class="cap">Step {step + 1} of {ORDER.length}</p>
          </>
        )}
        {mute && <button type="button" class="btn quiet wl-mute" aria-pressed={!mute.muted} onClick={mute.toggle}>{mute.muted ? "Sound off" : "Sound on"}</button>}
      </header>
      {children}
    </div>
  );
}

/** The mark assembling itself: the bar draws out, then the dot comes down and settles on it. */
function LandingMark() {
  return (
    <svg class="wl-mark" viewBox="0 0 240 120" width="240" height="120" aria-hidden="true">
      <rect class="wl-mark-bar" x="24" y="78" width="192" height="14" rx="4" />
      <circle class="wl-mark-dot" cx="158" cy="58" r="20" />
    </svg>
  );
}

/** The page's sounds, with a mute switch; one audio context for the life of the page. */
function useSound(): { readonly sound: Sound; readonly mute: Mute } {
  const ref = useRef<Sound | null>(null);
  if (!ref.current) ref.current = createSound();
  const sound = ref.current;
  const [muted, setMuted] = useState(false);
  useEffect(() => () => sound.close(), [sound]);
  const toggle = () => {
    sound.setMuted(!muted);
    setMuted(!muted);
  };
  return { sound, mute: { muted, toggle } };
}

/** perch://welcome#restore: this Mac has Perch data but not its key (spec 11.1). */
function Restore({ onDone }: { readonly onDone: () => void }) {
  const api = useApi();
  const [restored, setRestored] = useState(false);
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [freshError, setFreshError] = useState<string | null>(null);

  const startFresh = async () => {
    setFreshError(null);
    try {
      await api.startFresh();
      onDone();
    } catch (e) {
      setFreshError(errorText(e));
    }
  };

  return (
    <Stage>
    <main class="wl">
      <h1 class="serif-title" tabIndex={-1}>Restore your Perch data</h1>
      <p class="wl-lead">This Mac has your Perch data but not its key. Enter your recovery key to unlock it.</p>
      <div class="wl-body"><RestoreForm onRestored={() => setRestored(true)} /></div>
      {restored ? (
        <div class="wl-actions">
          <button type="button" class="btn primary" onClick={onDone}>Continue</button>
        </div>
      ) : confirmFresh ? (
        <div class="wl-body restore-confirm" role="alert">
          <p>Perch moves the old data aside, untouched, and starts with an empty memory and no chats. Your recovery key still opens the old data if you find it later.</p>
          <div>
            <button type="button" class="btn" onClick={() => setConfirmFresh(false)}>Cancel</button>
            <button type="button" class="btn primary" onClick={startFresh}>Start fresh</button>
          </div>
          {freshError && <p class="field-error">{freshError}</p>}
        </div>
      ) : (
        <div class="wl-actions">
          <button type="button" class="btn ghost" onClick={() => setConfirmFresh(true)}>I don't have my recovery key</button>
        </div>
      )}
    </main>
    </Stage>
  );
}

/** The restore view shows for #restore, or when the browser says this Mac's data has no key. */
function useRestoreView() {
  const [asked] = useState(() => window.location.hash === "#restore");
  const [done, setDone] = useState(false);
  const security = useLoad((a) => a.getSecurity());
  const loading = !asked && !security.data && !security.error;
  const show = !done && (asked || Boolean(security.data?.needsRestore));
  const finish = () => {
    setDone(true);
    if (window.location.hash === "#restore") history.replaceState(null, "", window.location.pathname + window.location.search);
  };
  return { loading, show, finish };
}

/** The first-run welcome screen. Every step can be skipped. */
export function Welcome() {
  const restore = useRestoreView();
  if (restore.loading) return null;
  if (restore.show) return <Restore onDone={restore.finish} />;
  return <Setup />;
}

function Setup() {
  const api = useApi();
  const act = useAction();
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focus = () => requestAnimationFrame(() => heading.current?.focus());
  const { sound, mute } = useSound();
  // The opening chime lands as the dot settles on the bar.
  useEffect(() => {
    const timer = setTimeout(() => sound.play("open"), 700);
    return () => clearTimeout(timer);
  }, [sound]);

  const finish = async (page: "newtab" | "memory" = "newtab") => {
    sound.play("done");
    await act(() => api.finishOnboarding());
    await act(() => api.openPage(page, page === "memory" ? "setup" : undefined));
  };
  const advance = async (completed: boolean) => {
    if (!step) return;
    if (completed) await act(() => api.completeOnboardingStep(step));
    const next = ORDER[ORDER.indexOf(step) + 1];
    if (next) {
      sound.play("step");
      setStep(next);
      focus();
    } else await finish();
  };

  if (!step) {
    return (
      <Stage mute={mute}>
        <main class="wl wl-hero">
          <LandingMark />
          <h1 class="serif-title" ref={heading} tabIndex={-1}>Welcome to Perch</h1>
          <p class="wl-lead">A browser with an agent that works on the sites you're signed in to. What it learns stays on this Mac, encrypted.</p>
          <div class="wl-actions">
            <button type="button" class="btn primary" onClick={() => { sound.play("step"); setStep("appearance"); focus(); }}>Set up Perch</button>
            <button type="button" class="btn quiet" onClick={() => finish()}>Skip setup</button>
          </div>
          <p class="cap">Four short steps. You can skip any of them.</p>
        </main>
      </Stage>
    );
  }

  const index = ORDER.indexOf(step);
  const back = () => { setStep(ORDER[index - 1] ?? null); focus(); };
  return (
    <Stage step={index} mute={mute}>
    <main class="wl" key={step}>
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
        <button type="button" class="btn quiet wl-back" onClick={back}>Back</button>
      </div>
    </main>
    </Stage>
  );
}
