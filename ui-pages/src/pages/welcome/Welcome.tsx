import { Fragment } from "preact";
import type preact from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Provider } from "../../api";
import { ACCENTS, ACCENT_NAMES, THEMES, THEME_NAMES } from "../../theme/tokens";
import { errorText, useAction, useApi, useAppearance, useLoad } from "../../ui/frame";
import { PerchMark } from "../../ui/PerchMark";
import { Blossom, Petals } from "../../ui/Sakura";
import { PasteCode } from "../../ui/PasteCode";
import { ProviderMark } from "../../ui/ProviderMark";
import { SignInButton } from "../../ui/SignInButton";
import { ImportWizard, type ImportStatus } from "../import/ImportWizard";
import { AgentsStep } from "../tour/TourSteps";
import { OnePasswordGroup } from "../settings/OnePassword";
import { RestoreForm } from "../settings/Backup";
import { Swatches } from "../../ui/Swatches";
import { createSound, type Sound } from "./sound";
import "./welcome.css";

const RESTORE_CHECK_MS = 3000;

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
      <p class="note">Change it any time in Settings. Perch reopens your tabs when it starts.</p>
    </div>
  );
}

/** The model sign-ins. The list belongs to the setup screen, which needs to know when one is connected. */
function Models({ providers, onChange }: { readonly providers: readonly Provider[]; readonly onChange: (p: Provider) => void }) {
  const api = useApi();
  const act = useAction();
  // Claude's sign-in page shows a code to paste back here.
  const [awaiting, setAwaiting] = useState<Provider["id"] | null>(null);
  const list = providers.filter((p) => p.kind === "subscription");
  return (
    <div class="card">
      {list.map((p) => (
        <Fragment key={p.id}>
        <div class="srow" id={`prov-${p.id}`}>
          <ProviderMark id={p.id} />
          <div><div class="n">{p.name}</div><div class="d">{p.detail}</div></div>
          <div class="ctl">
            {p.state === "connected" ? (
              <span class="status ok"><span class="dotc" />Connected{p.account ? ` · ${p.account}` : ""}</span>
            ) : (
              <SignInButton provider={p} onDone={onChange} onCode={() => setAwaiting(p.id)} />
            )}
          </div>
        </div>
        {awaiting === p.id && (
          <PasteCode provider={p} onCancel={() => setAwaiting(null)} onDone={(r) => {
            setAwaiting(null);
            onChange(r);
          }} />
        )}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The welcome page fills the window: on first run Perch hides the tab strip and toolbar while it
 * shows, leaving only the window's own buttons at the top left, which the bar keeps clear of.
 */
type Mute = { readonly muted: boolean; readonly toggle: () => void };

function Stage({ mute, step, children }: { readonly mute?: Mute; readonly step?: { readonly at: number; readonly of: number }; readonly children: preact.ComponentChildren }) {
  return (
    <div class="wl-stage">
      <Petals />
      <header class="wl-top">
        <span class="wl-brand"><PerchMark size={20} />Perch</span>
        {step && (
          <ol class="wl-dots" aria-label={`Step ${step.at + 1} of ${step.of}`}>
            {Array.from({ length: step.of }, (_, i) => <li key={i} class={i < step.at ? "done" : i === step.at ? "on" : ""} />)}
          </ol>
        )}
        {mute && <button type="button" class="btn quiet wl-mute" onClick={mute.toggle}>{mute.muted ? "Sound off" : "Sound on"}</button>}
      </header>
      {children}
    </div>
  );
}

/** The mark assembling itself: the branch draws out, then the bird glides in and lands on it. */
function LandingMark() {
  return (
    <svg class="wl-mark" viewBox="160 290 700 450" width="240" height="154" aria-hidden="true">
      <rect class="wl-mark-bar" x="176" y="686" width="672" height="30" rx="15" />
      <g class="wl-mark-bird">
        <path transform="translate(40 -45) rotate(-40 512 512)" d="M352.0 258.0 L352.0 654.0 Q352 676 368.6 661.5 L445.4 594.5 Q462 580 471.3 599.9 L536.7 740.1 Q546 760 566.3 751.6 L593.7 740.4 Q614 732 604.7 712.1 L541.3 575.9 Q532 556 554.0 556.0 L658.0 556.0 Q680 556 664.3 540.6 L367.7 251.4 Q352 236 352.0 258.0 Z" />
        {/* Sakura mode: a blossom in the bird's eye. */}
        <g transform="translate(384 438)">
          <g class="wl-mark-blossom">
            <Blossom r={64} />
          </g>
        </g>
      </g>
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
  // The button that opens the confirmation goes away with it, so focus moves into the confirmation
  // and comes back to that button on Cancel.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const confirm = (open: boolean) => {
    setConfirmFresh(open);
    requestAnimationFrame(() => (open ? cancelRef : askRef).current?.focus());
  };

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
    <main class="wl wl-restore">
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
            <button type="button" class="btn" ref={cancelRef} onClick={() => confirm(false)}>Cancel</button>
            <button type="button" class="btn primary" onClick={startFresh}>Start fresh</button>
          </div>
          {freshError && <p class="field-error">{freshError}</p>}
        </div>
      ) : (
        <div class="wl-actions">
          <button type="button" class="btn quiet" ref={askRef} onClick={() => confirm(true)}>I don't have my recovery key</button>
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
  // A browser that never answers shouldn't leave a blank window: after a few seconds, show setup.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), RESTORE_CHECK_MS);
    return () => clearTimeout(timer);
  }, []);
  const loading = !asked && !waited && !security.data && !security.error;
  const show = !done && (asked || Boolean(security.data?.needsRestore));
  const finish = () => {
    setDone(true);
    if (window.location.hash === "#restore") history.replaceState(null, "", window.location.pathname + window.location.search);
  };
  return { loading, show, finish };
}

/** The first-run welcome: one screen. A model is required; importing, and with it memory, is optional. */
export function Welcome() {
  const restore = useRestoreView();
  if (restore.loading) return null;
  if (restore.show) return <Restore onDone={restore.finish} />;
  return <Setup />;
}

type StepId = "plan" | "import" | "passwords" | "agents" | "look";
const STEPS: readonly StepId[] = ["plan", "import", "passwords", "agents", "look"];

const COPY: Readonly<Record<StepId, { readonly title: string; readonly lead: string }>> = {
  plan: {
    title: "Connect your plan",
    lead: "Perch runs on the Claude, ChatGPT or Grok plan you already have.",
  },
  import: {
    title: "Bring everything over",
    lead: "Tabs, bookmarks, history, passwords and your sign-ins.",
  },
  passwords: {
    title: "Connect your password manager",
    lead: "So Perch can sign in to your sites, as it builds your memory and later.",
  },
  agents: {
    title: "Let your coding agents use Perch",
    lead: "Claude Code, Codex and Grok can use this browser, signed in as you.",
  },
  look: { title: "Make it yours", lead: "Pick a theme and an accent." },
};

function Setup() {
  const api = useApi();
  const act = useAction();
  const providers = useLoad((a) => a.listProviders());
  const [step, setStep] = useState<StepId | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus>("idle");
  const [imported, setImported] = useState(false);
  const [memory, setMemory] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const { sound, mute } = useSound();
  // The opening chime lands as the bird settles on the bar.
  useEffect(() => {
    const timer = setTimeout(() => sound.play("open"), 700);
    return () => clearTimeout(timer);
  }, [sound]);

  // Claude Code runs chats but not Perch's own background work (memory, routines), so one of the
  // plans that signs in here is what setup needs.
  const connected = (providers.data ?? []).some((p) => p.state === "connected" && p.id !== "claude-code");
  const onProvider = async (p: Provider) => {
    providers.set((providers.data ?? []).map((x) => (x.id === p.id ? p : x)));
    if (p.state === "connected") {
      sound.play("step");
      await act(() => api.completeOnboardingStep("models"));
    }
  };
  const onImport = async (status: ImportStatus) => {
    setImportStatus(status);
    if (status === "done" && !imported) {
      setImported(true);
      sound.play("step");
      await act(() => api.completeOnboardingStep("import"));
    }
  };

  const go = (next: StepId | null) => {
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const finish = async () => {
    sound.play("done");
    await act(() => api.completeOnboardingStep("appearance"));
    // Memory from what came over builds in a chat of its own, in a tab behind this one.
    if (imported && memory) {
      await act(() => api.completeOnboardingStep("memory"));
      await act(() => api.startMemoryChat());
    }
    // If saving fails, stay here (the error shows) rather than leave and see setup again next launch.
    if (!(await act(() => api.finishOnboarding().then(() => true)))) return;
    await act(() => api.openPage("tour", imported && memory ? "memory" : undefined));
  };

  if (!step) {
    return (
      <Stage mute={mute}>
        <main class="wl wl-hero">
          <LandingMark />
          <h1 class="serif-title" ref={heading} tabIndex={-1}>Welcome to Perch</h1>
          <p class="wl-lead">A browser with an agent that works on the sites you're signed in to. What it learns stays on this Mac, encrypted.</p>
          <div class="wl-actions">
            <button type="button" class="btn primary" onClick={() => { sound.play("step"); go("plan"); }}>Get started</button>
          </div>
          <p class="cap">Five quick steps.</p>
        </main>
      </Stage>
    );
  }

  const at = STEPS.indexOf(step);
  const next = STEPS[at + 1] ?? null;
  const back = () => go(STEPS[at - 1] ?? null);
  const running = importStatus === "running";
  const blocked = step === "plan" ? !connected : step === "import" ? running : false;
  const hint =
    step === "plan" && !connected ? "Sign in to Claude, ChatGPT or Grok to continue." : step === "import" && running ? "Waiting for the import to finish." : "";
  const forward = () => {
    sound.play("step");
    if (next) go(next);
    else void finish();
  };

  return (
    <Stage mute={mute} step={{ at, of: STEPS.length }}>
      <main class="wl" key={step}>
        <h1 class="serif-title" ref={heading} tabIndex={-1}>{COPY[step].title}</h1>
        <p class="wl-lead">{COPY[step].lead}</p>
        <div class="wl-body">
          {step === "plan" && providers.error && <p class="err-note">{providers.error}</p>}
          {step === "plan" && providers.data && (
            <>
              <Models providers={providers.data} onChange={onProvider} />
              <p class="note">Claude Code alone can't run memory or routines. API keys are in Settings.</p>
            </>
          )}
          {step === "import" && (
            <>
              <ImportWizard embedded onStatus={onImport} />
              {imported && (
                <label class="pick data wl-check">
                  <input type="checkbox" checked={memory} onChange={() => setMemory(!memory)} />
                  <span class="pick-t">
                    <span class="ink">Build my memory from what came over</span>
                    <span class="cap">Runs in its own tab while you carry on. Stays on this Mac, encrypted.</span>
                  </span>
                </label>
              )}
            </>
          )}
          {step === "passwords" && (
            <>
              <OnePasswordGroup />
              <p class="note">No password manager? When a site needs a login, Perch asks you in the chat and types it in itself.</p>
            </>
          )}
          {step === "agents" && <AgentsStep onInstalled={() => undefined} next={null} />}
          {step === "look" && <Look />}
        </div>
        <div class="wl-actions wl-finish">
          <button type="button" class="btn quiet" onClick={back}>Back</button>
          <span class="grow" />
          {hint && <span class="cap" role="status">{hint}</span>}
          {/* One way forward per step: skipping the import is the plain button, Continue once something came over. */}
          {step === "import" && !imported ? (
            <button type="button" class="btn" disabled={blocked} onClick={forward}>Skip for now</button>
          ) : (
            <button type="button" class="btn primary" disabled={blocked} onClick={forward}>{next ? "Continue" : "Finish setup"}</button>
          )}
        </div>
      </main>
    </Stage>
  );
}
