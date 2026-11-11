import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { Effort, Model, Provider, TaskModel, TaskRole } from "../../api";
import { EFFORTS, EFFORT_LABELS, ROLES } from "../../lib/labels";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { useManaged } from "../../ui/useManaged";
import { Icon, Plus } from "../../ui/icons";
import { Group, Row } from "../../ui/Row";
import { ProviderMark } from "../../ui/ProviderMark";
import { Switch } from "../../ui/Switch";
import { ConnectDialog } from "./ConnectDialog";

function ProviderStatus({ p }: { readonly p: Provider }) {
  if (p.state === "connected") return <span class="status ok"><span class="dotc" />Connected{p.account ? ` · ${p.account}` : ""}</span>;
  if (p.state === "not-installed") return <span class="status warn"><span class="dotc" />Claude Code isn't installed</span>;
  if (p.state === "error") return <span class="status bad"><span class="dotc" />{p.message ?? "Sign-in failed"}</span>;
  return <span class="status"><span class="dotc" />Not connected</span>;
}

function Providers({ onModelsChanged }: { readonly onModelsChanged: () => void }) {
  const api = useApi();
  const act = useAction();
  const providers = useLoad((a) => a.listProviders());
  const { locked } = useManaged();
  const [connecting, setConnecting] = useState<Provider | null>(null);
  /** A sign-in whose page shows a code to paste back (Claude), and what has been pasted so far. */
  const [awaiting, setAwaiting] = useState<{ id: Provider["id"]; code: string } | null>(null);
  const [showMore, setShowMore] = useState(false);
  const list = providers.data ?? [];
  const replace = (p: Provider) => {
    providers.set(list.map((x) => (x.id === p.id ? p : x)));
    onModelsChanged();
  };
  const visible = list.filter((p) => showMore || p.kind === "subscription" || p.state === "connected");

  const action = (p: Provider) => {
    if (p.kind === "subscription") {
      return p.state === "connected" ? (
        <button type="button" class="btn" aria-label={`Sign out of ${p.name}`} onClick={async () => { const r = await act(() => api.signOut(p.id), `Signed out of ${p.name}`); if (r) replace(r); }}>Sign out</button>
      ) : (
        <button
          type="button"
          class="btn"
          aria-label={`Sign in to ${p.name}`}
          onClick={async () => {
            const r = await act(() => api.signIn(p.id), "");
            if (!r) return;
            if (r.awaitingCode) setAwaiting({ id: p.id, code: "" });
            else replace(r);
          }}
        >
          Sign in
        </button>
      );
    }
    if (p.state === "connected") {
      return <button type="button" class="btn" aria-label={`Remove ${p.name}`} onClick={async () => { const r = await act(() => api.signOut(p.id), `Removed ${p.name}`); if (r) replace(r); }}>Remove</button>;
    }
    return (
      <button type="button" class="btn" aria-label={p.kind === "local" ? `Connect ${p.name}` : `Add key for ${p.name}`} onClick={() => setConnecting(p)}>
        {p.kind === "local" ? "Connect" : "Add key"}
      </button>
    );
  };

  return (
    <Group label="Providers" id="providers">
      <div class="card">
        {providers.error && <p class="empty">{providers.error}</p>}
        {visible.map((p) => (
          <Fragment key={p.id}>
            <Row title={p.name} detail={p.detail} icon={<ProviderMark id={p.id} />}>
              <ProviderStatus p={p} />
              {action(p)}
            </Row>
            {awaiting?.id === p.id && (
              <form
                class="paste-code"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await act(() => api.finishSignIn(p.id, awaiting.code.trim()), `Signed in to ${p.name}`);
                  if (!r) return;
                  setAwaiting(null);
                  replace(r);
                }}
              >
                <label for={`code-${p.id}`}>Paste the code {p.name} shows after you approve</label>
                <input id={`code-${p.id}`} class="input" autoFocus spellcheck={false} autoComplete="off" value={awaiting.code} onInput={(e) => setAwaiting({ id: p.id, code: e.currentTarget.value })} />
                <button type="submit" class="btn primary" disabled={!awaiting.code.trim()}>Continue</button>
                <button type="button" class="btn" onClick={() => setAwaiting(null)}>Cancel</button>
              </form>
            )}
          </Fragment>
        ))}
        {!showMore && (
          <button type="button" class="more-row" onClick={() => setShowMore(true)}>
            <Icon of={Plus} />Connect an API key or a model on this Mac
          </button>
        )}
      </div>
      <p class="note">Claude signs in with your Pro or Max plan and Perch calls it directly. Claude Code instead runs whole tasks with its own sign-in on this Mac; Perch never reads its tokens.</p>
      {locked("providers") && <p class="note">Your organization chooses which providers and models you can use.</p>}
      <ConnectDialog
        provider={connecting}
        onClose={() => setConnecting(null)}
        onDone={(p) => {
          setConnecting(null);
          replace(p);
        }}
      />
    </Group>
  );
}

const fitsRole = (role: TaskRole, m: Model) =>
  role === "image" ? m.imageGeneration : role === "visual" ? m.vision && !m.imageGeneration : !m.imageGeneration;

function TaskModels({ models }: { readonly models: readonly Model[] }) {
  const api = useApi();
  const act = useAction();
  const tasks = useLoad((a) => a.getTaskModels());
  const save = async (role: TaskRole, patch: Partial<Omit<TaskModel, "role">>) => {
    const next = await act(() => api.setTaskModel(role, patch));
    if (next && tasks.data) tasks.set(tasks.data.map((t) => (t.role === role ? next : t)));
  };
  return (
    <Group label="Task models" id="task-models">
      <div class="card">
        {models.length === 0 && <p class="empty">Sign in to a provider above to pick models.</p>}
        {models.length > 0 && (tasks.data ?? []).map((t) => {
          const options = models.filter((m) => fitsRole(t.role, m));
          const label = ROLES[t.role].label;
          return (
            <Row key={t.role} id={`role-${t.role}`} title={label} detail={ROLES[t.role].detail}>
              <select class="picker" aria-label={`${label} model`} value={t.modelId ?? ""} onChange={(e) => save(t.role, { modelId: (e.currentTarget as HTMLSelectElement).value })}>
                {!options.some((m) => m.id === t.modelId) && <option value="">Choose a model</option>}
                {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              {t.role !== "image" && (
                <>
                  <select class="picker" aria-label={`${label} effort`} value={t.effort} onChange={(e) => save(t.role, { effort: (e.currentTarget as HTMLSelectElement).value as Effort })}>
                    {EFFORTS.map((x) => <option key={x} value={x}>{EFFORT_LABELS[x]}</option>)}
                  </select>
                  <span class="status">Fast</span>
                  <Switch label={`${label} fast mode`} checked={t.fast} onChange={(fast) => save(t.role, { fast })} />
                </>
              )}
            </Row>
          );
        })}
      </div>
    </Group>
  );
}

export function Models() {
  const models = useLoad((a) => a.listModels());
  return (
    <div class="sec">
      <Providers onModelsChanged={models.reload} />
      <TaskModels models={models.data ?? []} />
    </div>
  );
}
