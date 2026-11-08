/**
 * The real old Keychain stores, as migrate.ts sources (plan 3b, task 3). The Keychain can't list a
 * service's accounts without reading them, so each source names the items it may hold from what
 * Perch knows: fixed names, the model providers, the MCP servers in the registry, the clients file.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { macKeychain as appKeychain } from "../app/keychain";
import { SETTINGS_KEY_NAME } from "../config/store";
import { systemKeychain } from "../config/keychain";
import { readRecordNames } from "../daemon/clients";
import { MacKeychain as DaemonKeychain } from "../daemon/keychain";
import { macKeychain as memoryKeychain } from "../memory/keychain";
import { clientAccount, tokenAccount } from "../mcp-client/oauth";
import { RegistryStore } from "../mcp-client/registry";
import { secretAccounts } from "../mcp-client/secrets";
import type { ProviderId } from "../models/ids";
import { PROVIDERS, secretName } from "../models/providers";
import { macKeychain as syncKeychain, SECRET_NAMES } from "../sync/keychain";
import { MacKeychain as SecureKeychain } from "./keychain";
import type { LegacyItem, LegacySource } from "./migrate";

export type LegacyOptions = {
  /** The user data folder's "Perch Agent", where the MCP registry and settings live today. */
  readonly agentDir: string;
  readonly clientsFile: string;
  readonly profile: string;
};

const item = (name: string, read: () => Promise<string | null>, remove: () => Promise<unknown>): LegacyItem => ({
  name,
  // A failed read stops the move (the Keychain may be locked); it is never taken as "not there".
  read,
  remove: async () => void (await remove()),
});

export function legacySources(opts: LegacyOptions): LegacySource[] {
  // The vault has no delete in its adapter; the item is a plain generic password, so the FFI one removes it.
  const vaultDelete = new SecureKeychain({ service: "Perch Data Key" });
  const app = appKeychain();
  const config = systemKeychain();
  const clients = new DaemonKeychain("Perch clients");
  const seal = new DaemonKeychain("Perch registry");
  const memory = memoryKeychain();
  const sync = syncKeychain();
  const secure = new SecureKeychain();
  const providers = Object.keys(PROVIDERS) as ProviderId[];

  return [
    { id: "app", store: "app", items: async () => [item(`Perch Data Key/${opts.profile}`, () => app.read("Perch Data Key", opts.profile), () => vaultDelete.delete(opts.profile))] },
    {
      id: "config",
      store: "config",
      items: async () => [SETTINGS_KEY_NAME, ...providers.map(secretName)].map((n) => item(n, () => config.get(n), () => config.delete(n))),
    },
    {
      id: "clients",
      store: "daemon",
      items: async () => readRecordNames(opts.clientsFile).map((n) => item(`Perch clients/${n}`, () => clients.get(n), () => clients.delete(n))),
    },
    { id: "client-seal", store: "daemon", items: async () => [item("Perch registry/registry", () => seal.get("registry"), () => seal.delete("registry"))] },
    { id: "memory", store: "memory", items: async () => [`data-key:${opts.profile}`].map((n) => item(n, () => memory.get(n), () => memory.delete(n))) },
    { id: "sync", store: "sync", items: async () => SECRET_NAMES.map((n) => item(n, () => sync.get(n), () => sync.delete(n))) },
    {
      id: "secure",
      store: "secure",
      items: async () => {
        const registry = join(opts.agentDir, "mcp-servers.enc");
        // Reading the registry needs the old data key; only open it when it exists, so nothing new is created.
        const servers = existsSync(registry) ? (await new RegistryStore(registry, secure).load()).servers : [];
        const names = ["data-key", ...servers.flatMap((s) => [...secretAccounts(s.config), tokenAccount(s.name), clientAccount(s.name)])];
        return [...new Set(names)].map((n) => item(n, () => secure.get(n), () => secure.delete(n)));
      },
    },
  ];
}
