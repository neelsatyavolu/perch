/**
 * Settings › Permissions › 1Password: which 1Password accounts, and which vaults in each, the
 * agent may fill logins and one-time codes from (secure/onepassword.ts). Adding an account checks
 * it right away, so 1Password's prompt shows while the person is looking at the setting, not mid-task.
 */

import type { OnePasswordChoice, OnePasswordSettings } from "../../../../ui-pages/src/api";
import { listVaults, OnePasswordError, onePasswordStatus, type OpRun } from "../../secure/onepassword";
import { AppError } from "../runs";
import * as v from "../validate";
import { notYet, type Methods } from "./common";
import type { PagesDeps } from "./deps";
import type { PagesSettings } from "./state";

const MAX_ACCOUNTS = 10;
const MAX_VAULTS = 200;

/** What the agent may use, including the one account 0.1.5 saved before vaults could be chosen. */
export function chosenOf(s: PagesSettings): readonly OnePasswordChoice[] {
  if (s.onePassword) return s.onePassword;
  return s.onePasswordAccount ? [{ account: s.onePasswordAccount, vaults: null }] : [];
}

/** A 1Password error as the page shows it: the reason, and 1Password's own words in `detail`. */
function fromOp(error: unknown): never {
  if (error instanceof OnePasswordError) throw new AppError(error.detail ? `${error.message} 1Password said: ${error.detail}` : error.message);
  throw error;
}

export function onePasswordPages(deps: PagesDeps): Methods<"getOnePassword" | "setOnePassword" | "listOnePasswordVaults"> {
  const runner = (): OpRun => {
    if (!deps.onePassword) notYet("This build of Perch can't reach 1Password.");
    const run = deps.onePassword.run;
    if (!run) throw new AppError("Install 1Password's command-line tool first (brew install 1password-cli)");
    return run;
  };

  const read = async (): Promise<OnePasswordSettings> => {
    const run = deps.onePassword?.run ?? null;
    const [status, settings] = await Promise.all([onePasswordStatus(run), deps.state.get()]);
    const chosen = chosenOf(settings);
    const gone = status.accounts.length > 0 ? chosen.filter((c) => !status.accounts.some((a) => a.id === c.account)) : [];
    const problem = gone.length ? "A 1Password account Perch was using isn't in the 1Password app any more. Turn it off below." : status.error;
    if (status.detail) process.stderr.write(`perchd: 1Password: ${status.detail}\n`);
    return {
      installed: status.installed,
      accounts: status.accounts,
      chosen,
      ...(problem ? { problem } : {}),
      ...(status.detail ? { detail: status.detail } : {}),
    };
  };

  return {
    getOnePassword: async () => read(),

    async listOnePasswordVaults([raw]) {
      const account = v.text(raw, "account", 128);
      return listVaults(runner(), account).catch(fromOp);
    },

    async setOnePassword([raw]) {
      const list = v.list(raw, "chosen", MAX_ACCOUNTS).map((item, i): OnePasswordChoice => {
        const o = v.object(item, `chosen[${i}]`);
        v.onlyKeys(o, ["account", "vaults"]);
        const vaults = o.vaults === null ? null : [...new Set(v.list(o.vaults, `chosen[${i}].vaults`, MAX_VAULTS).map((x, j) => v.text(x, `chosen[${i}].vaults[${j}]`, 64)))];
        return { account: v.text(o.account, `chosen[${i}].account`, 128), vaults };
      });
      if (new Set(list.map((c) => c.account)).size !== list.length) throw new AppError("Each 1Password account goes in once");
      if (list.some((c) => c.vaults !== null && c.vaults.length === 0)) throw new AppError("Pick at least one vault, or turn the account off");
      if (list.length > 0) {
        const run = runner();
        const status = await onePasswordStatus(run);
        const before = new Set(chosenOf(await deps.state.get()).map((c) => c.account));
        for (const c of list) {
          if (status.accounts.length > 0 && !status.accounts.some((a) => a.id === c.account)) throw new AppError("That account isn't in the 1Password app");
          // A new account, or a vault list, is checked against 1Password now: Touch ID shows while the person is here.
          if (before.has(c.account) && c.vaults === null) continue;
          const vaults = await listVaults(run, c.account).catch(fromOp);
          if (c.vaults?.some((id) => !vaults.some((x) => x.id === id))) throw new AppError("One of those vaults isn't in that 1Password account");
        }
      }
      await deps.state.update(({ onePasswordAccount: _, onePassword: __, ...rest }) => (list.length ? { ...rest, onePassword: list } : rest));
      return read();
    },
  };
}
