/**
 * Settings › Passwords › 1Password: whether the agent may fill logins and one-time codes from the
 * 1Password app (secure/onepassword.ts). Turning it on checks the account right away, so the
 * Touch ID prompt shows while the person is looking at the switch, not mid-task.
 */

import type { OnePasswordSettings } from "../../../../ui-pages/src/api";
import { onePasswordStatus, verifyAccount } from "../../secure/onepassword";
import { AppError } from "../runs";
import * as v from "../validate";
import { notYet, plainly, type Methods } from "./common";
import type { PagesDeps } from "./deps";

export function onePasswordPages(deps: PagesDeps): Methods<"getOnePassword" | "setOnePassword"> {
  const read = async (): Promise<OnePasswordSettings> => {
    const run = deps.onePassword?.run ?? null;
    const [status, settings] = await Promise.all([onePasswordStatus(run), deps.state.get()]);
    const account = settings.onePasswordAccount ?? null;
    const missing = account && status.installed && status.accounts.length > 0 && !status.accounts.some((a) => a.id === account);
    const problem = missing ? "That 1Password account isn't in the 1Password app any more. Pick another." : status.error;
    return { installed: status.installed, accounts: status.accounts, account, ...(problem ? { problem } : {}) };
  };

  return {
    getOnePassword: async () => read(),
    async setOnePassword([raw]) {
      if (raw === null) {
        await deps.state.update(({ onePasswordAccount: _, ...rest }) => rest);
        return read();
      }
      const account = v.text(raw, "account", 128);
      const run = deps.onePassword?.run;
      if (!deps.onePassword) notYet("This build of Perch can't reach 1Password.");
      if (!run) throw new AppError("Install 1Password's command-line tool first (brew install 1password-cli)");
      const status = await onePasswordStatus(run);
      if (!status.accounts.some((a) => a.id === account)) throw new AppError("That account isn't in the 1Password app");
      await plainly(() => verifyAccount(run, account));
      await deps.state.update((s) => ({ ...s, onePasswordAccount: account }));
      return read();
    },
  };
}
