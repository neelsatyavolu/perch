import { useState } from "preact/hooks";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Group, Row } from "../../ui/Row";
import { Switch } from "../../ui/Switch";

const CLI_GUIDE = "https://developer.1password.com/docs/cli/get-started/";

/**
 * Settings › Permissions › 1Password: lets the agent's "sign in" and "fill code" use logins from
 * the 1Password app when Perch has none saved. 1Password asks for Touch ID itself; the agent never
 * sees a username, password or code.
 */
export function OnePasswordGroup() {
  const api = useApi();
  const act = useAction();
  const status = useLoad((a) => a.getOnePassword());
  const [busy, setBusy] = useState(false);
  const s = status.data;
  const on = Boolean(s?.account);
  const [picked, setPicked] = useState<string>("");
  const account = picked || s?.account || s?.accounts[0]?.id || "";

  const set = async (next: string | null) => {
    setBusy(true);
    const r = await act(() => api.setOnePassword(next), next ? "The agent can sign in with 1Password" : "1Password is off for the agent");
    setBusy(false);
    if (r) status.set(r);
  };

  return (
    <Group label="1Password" id="one-password">
      <div class="card">
        <Row
          id="one-password-on"
          title="Sign in with 1Password"
          detail={on ? "When Perch has no saved login for a site, the agent asks 1Password. You approve with Touch ID." : "Let the agent use logins and one-time codes from the 1Password app."}
        >
          <Switch label="Sign in with 1Password" checked={on} disabled={busy || !s || (!on && (!s.installed || s.accounts.length === 0))} describedBy="one-password-on-d" onChange={(next) => set(next ? account : null)} />
        </Row>
        {s && s.accounts.length > 1 && (
          <Row title="Account" sub>
            <select class="picker" aria-label="1Password account" value={account} disabled={busy}
              onChange={(e) => {
                const id = (e.currentTarget as HTMLSelectElement).value;
                setPicked(id);
                if (on) set(id);
              }}>
              {s.accounts.map((a) => <option key={a.id} value={a.id}>{a.email || a.url}</option>)}
            </select>
          </Row>
        )}
      </div>
      {status.error && <p class="err-note">{status.error}</p>}
      {s?.problem && (
        <p class="note">
          {s.problem}
          {!s.installed && <> <a href={CLI_GUIDE} target="_blank" rel="noreferrer">How to install it</a></>}
        </p>
      )}
      <p class="note">The agent sees only whether the sign-in worked, never the username, password or code. In Guard, Perch asks before the agent signs in to a site for the first time.</p>
    </Group>
  );
}
