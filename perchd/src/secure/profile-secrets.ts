/**
 * A profile's secrets inside Perch (plan 3b, task 3): one sealed file per store under
 * `<profile>/Perch Agent/secrets/`, each sealed with the key HKDF derives for that store from the
 * root key the browser sent on fd 5. The adapters below give each module the interface it already
 * uses, so the modules don't change.
 *
 * The data keys those modules used to make for themselves (the vault key, memory's data key, the
 * sealed-file key) now live inside these files, so every file Perch encrypts is, one step removed,
 * under the Secure Enclave-wrapped root key.
 */

import { stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sealedKeychain as sealedAppKeychain } from "../app/keychain";
import { sealedKeychain as sealedConfigKeychain } from "../config/keychain";
import { SealedKeychain } from "../daemon/keychain";
import { BUNDLE_SERVICE } from "../import/bundle";
import { macKeychain as foreignKeychain, sealedImportKeychain } from "../import/keychain";
import { sealedKeyStore } from "../memory/keychain";
import { sealedSecretStore } from "./keychain";
import { sealedSecretStore as sealedSyncStore } from "../sync/keychain";
import type { KeyStoreName, ProfileKeys } from "./key-channel";
import { SealedSecrets } from "./sealed-secrets";

export function secretsDir(profileDir: string): string {
  return join(profileDir, "Perch Agent", "secrets");
}

export function openProfileSecrets(keys: ProfileKeys) {
  const dir = secretsDir(keys.dir);
  let stores: ReadonlyMap<KeyStoreName, SealedSecrets> = new Map();
  const store = (name: KeyStoreName): SealedSecrets => {
    const open = stores.get(name);
    if (open) return open;
    const made = new SealedSecrets(join(dir, `${name}.sealed`), keys.source.derive(name), name);
    stores = new Map([...stores, [name, made]]);
    return made;
  };
  return {
    protected: keys.protected,
    store,
    app: () => sealedAppKeychain(store("app")),
    config: () => sealedConfigKeychain(store("config")),
    clients: () => new SealedKeychain(store("daemon"), "Perch clients"),
    clientSeal: () => new SealedKeychain(store("daemon"), "Perch registry"),
    memory: () => sealedKeyStore(store("memory")),
    sync: () => sealedSyncStore(store("sync")),
    secure: () => sealedSecretStore(store("secure")),
    importer: () => sealedImportKeychain(store("import"), foreignKeychain(), [BUNDLE_SERVICE]),
  };
}

export type ProfileSecrets = ReturnType<typeof openProfileSecrets>;

/**
 * Saves the recovery copy of the root key the browser sent when it first made the key (spec 11.1).
 * It is the root key encrypted to the user's recovery key, so it is safe at rest; it is written once
 * and never replaced, so a later, different blob can't overwrite a working one.
 */
export async function saveRecovery(keys: ProfileKeys): Promise<boolean> {
  if (!keys.recovery) return false;
  const path = join(keys.dir, "Perch Agent", "root.recovery");
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (exists) return false;
  await mkdir(join(keys.dir, "Perch Agent"), { recursive: true, mode: 0o700 });
  await writeFile(path, keys.recovery, { mode: 0o600, flag: "wx" });
  return true;
}
