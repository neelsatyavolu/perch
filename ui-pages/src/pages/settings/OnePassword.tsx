import { useState } from "preact/hooks";
import type { OnePasswordChoice, OnePasswordVault } from "../../api";
import { useAction, useApi, useLoad } from "../../ui/frame";
import { Group, Row } from "../../ui/Row";
import { Segmented } from "../../ui/Segmented";
import { Switch } from "../../ui/Switch";

const CLI_GUIDE = "https://developer.1password.com/docs/cli/get-started/";

type Scope = "all" | "some";

/**
 * Settings › Permissions › 1Password: lets the agent's "sign in" and "fill code" use logins from
 * the 1Password app when Perch has none saved, from the accounts and vaults picked here. 1Password
 * asks for Touch ID itself; the agent never sees a username, password or code.
 */
export function OnePasswordGroup() {
  const api = useApi();
  const act = useAction();
  const status = useLoad((a) => a.getOnePassword());
  const [busy, setBusy] = useState(false);
  /** Vaults loaded per account, for "Choose vaults". */
  const [vaults, setVaults] = useState<Readonly<Record<string, readonly OnePasswordVault[]>>>({});
  const s = status.data;
  const chosen = s?.chosen ?? [];
  const on = chosen.length > 0;

  const save = async (next: readonly OnePasswordChoice[], done: string) => {
    setBusy(true);
    const r = await act(() => api.setOnePassword(next), done);
    setBusy(false);
    if (r) status.set(r);
  };
  const recheck = async () => {
    setBusy(true);
    const r = await act(() => api.getOnePassword());
    setBusy(false);
    if (r) status.set(r);
  };
  const loadVaults = async (account: string) => {
    if (vaults[account]) return vaults[account];
    const list = await act(() => api.listOnePasswordVaults(account));
    if (list) setVaults((v) => ({ ...v, [account]: list }));
    return list;
  };
  const choiceOf = (account: string) => chosen.find((c) => c.account === account);
  const withChoice = (account: string, choice: OnePasswordChoice | null): OnePasswordChoice[] => {
    const rest = chosen.filter((c) => c.account !== account);
    return choice ? [...rest, choice] : rest;
  };

  if (!s) return status.error ? <Group label="1Password" id="one-password"><p class="err-note">{status.error}</p></Group> : null;
  const unreachable = s.installed && s.accounts.length === 0;

  return (
    <Group label="1Password" id="one-password">
      <div class="card">
        <Row
          id="one-password-on"
          title="Sign in with 1Password"
          detail={on ? "When Perch has no saved login for a site, the agent asks 1Password. You approve with Touch ID." : "Let the agent use logins and one-time codes from the 1Password app."}
        >
          <Switch
            label="Sign in with 1Password"
            checked={on}
            disabled={busy || !s.installed || (!on && unreachable)}
            describedBy="one-password-on-d"
            onChange={(next) => save(next && s.accounts[0] ? [{ account: s.accounts[0].id, vaults: null }] : [], next ? "The agent can sign in with 1Password" : "1Password is off for the agent")}
          />
        </Row>
        {on && s.accounts.map((a) => {
          const choice = choiceOf(a.id);
          const scope: Scope = choice?.vaults ? "some" : "all";
          const loaded = vaults[a.id];
          return (
            <div key={a.id}>
              <Row title={a.email || a.url} detail={a.url && a.email ? a.url : undefined} sub>
                <Switch label={`Use ${a.email || a.url}`} checked={Boolean(choice)} disabled={busy}
                  onChange={(use) => save(withChoice(a.id, use ? { account: a.id, vaults: null } : null), use ? `Using ${a.email || a.url}` : `Not using ${a.email || a.url}`)} />
              </Row>
              {choice && (
                <Row title="Vaults" detail={scope === "all" ? "Every vault in this account" : "Only the vaults ticked below"} sub>
                  <Segmented<Scope> label={`Vaults in ${a.email || a.url}`} value={scope} options={[{ value: "all", label: "All vaults" }, { value: "some", label: "Choose vaults" }]}
                    onChange={async (next) => {
                      if (next === "all") return save(withChoice(a.id, { account: a.id, vaults: null }), "Every vault");
                      const list = await loadVaults(a.id);
                      if (list?.length) await save(withChoice(a.id, { account: a.id, vaults: list.map((v) => v.id) }), "Choose the vaults to use");
                    }} />
                </Row>
              )}
              {choice?.vaults && (
                <fieldset class="op-vaults" aria-label={`Vaults the agent may use in ${a.email || a.url}`}>
                  {(loaded ?? choice.vaults.map((id) => ({ id, name: id }))).map((v) => {
                    const picked = choice.vaults!.includes(v.id);
                    return (
                      <label key={v.id} class="op-vault">
                        <input type="checkbox" checked={picked} disabled={busy || (picked && choice.vaults!.length === 1)}
                          onChange={() => save(withChoice(a.id, { account: a.id, vaults: picked ? choice.vaults!.filter((x) => x !== v.id) : [...choice.vaults!, v.id] }), picked ? `Not using ${v.name}` : `Using ${v.name}`)} />
                        <span>{v.name}</span>
                      </label>
                    );
                  })}
                  {!loaded && <button type="button" class="btn quiet sm" onClick={() => loadVaults(a.id)}>Show vault names</button>}
                </fieldset>
              )}
            </div>
          );
        })}
      </div>
      {(s.problem || s.detail) && (
        <div class="note op-problem" role="status">
          {s.problem && <p>{s.problem}</p>}
          {s.detail && <p>1Password said: <span class="mono">{s.detail}</span></p>}
          <p>
            {s.installed ? <button type="button" class="btn quiet sm" disabled={busy} onClick={recheck}>Check again</button> : <a href={CLI_GUIDE} target="_blank" rel="noreferrer">How to install it</a>}
          </p>
        </div>
      )}
      <p class="note">The agent sees only whether the sign-in worked, never the username, password or code. In Guard, Perch asks before the agent signs in to a site for the first time.</p>
    </Group>
  );
}
