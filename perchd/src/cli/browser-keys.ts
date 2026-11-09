/**
 * perchd's secrets inside Perch (plan 3b, task 3): wait briefly for the profile's root key on fd 5,
 * save its recovery copy, move the old Keychain items into the sealed files, and hand back the
 * stores. A browser that sends no key (one built before the key broker) gets null, and perchd keeps
 * using the older Keychain stores.
 */

import { join } from "node:path";
import { withoutKeychainPrompts } from "../import/mac-security";
import type { KeyChannel } from "../secure/key-channel";
import { legacySources } from "../secure/legacy-sources";
import { migrateLegacy, type LegacySource } from "../secure/migrate";
import { openProfileSecrets, saveRecovery, type ProfileSecrets } from "../secure/profile-secrets";

/** How long perchd waits for a profile's key after the app line. The browser sends both at launch. */
export const KEY_WAIT_MS = 3000;

export type BrowserSecretsOptions = {
  profile: string;
  dataDir: string;
  clientsFile: string;
  log: (line: string) => void;
  /** Tests replace the real Keychain stores. */
  sources?: readonly LegacySource[];
  waitMs?: number;
};

export async function browserSecrets(channel: KeyChannel, opts: BrowserSecretsOptions): Promise<ProfileSecrets | null> {
  const keys = await channel.profile(opts.profile, opts.waitMs ?? KEY_WAIT_MS);
  if (!keys) {
    opts.log("perchd: the browser sent no profile key; using the Keychain\n");
    return null;
  }
  const secrets = openProfileSecrets(keys);
  try {
    if (await saveRecovery(keys)) opts.log("perchd: saved the recovery copy of the profile key\n");
  } catch (error) {
    opts.log(`perchd: could not save the recovery copy of the profile key (${(error as Error).message})\n`);
  }
  const sources = opts.sources ?? legacySources({ agentDir: join(opts.dataDir, "Perch Agent"), clientsFile: opts.clientsFile, profile: opts.profile });
  try {
    // Old items another build made would each ask the user to allow perchd; this move is never worth a prompt.
    const moved = (await withoutKeychainPrompts(() => migrateLegacy(sources, secrets.store))).reduce((n, r) => n + r.moved, 0);
    if (moved) opts.log(`perchd: moved ${moved} secrets from the Keychain into the profile's sealed files\n`);
  } catch (error) {
    // The rest stays in the Keychain until the next launch finishes the move.
    opts.log(`perchd: ${(error as Error).message}\n`);
  }
  if (!keys.protected) opts.log("perchd: this build's profile key is not protected by the Secure Enclave\n");
  return secrets;
}
