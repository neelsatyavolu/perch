/**
 * The user's MCP servers, kept in an encrypted settings file (spec 11.1). Updates are pure
 * functions that return a new registry; RegistryStore loads and saves it.
 */

import type { SecretStore } from "../secure/keychain";
import { dataKey, readSealedJson, writeSealedJson } from "../secure/sealed";
import { parseEntry, type ServerEntry } from "./types";

export type Registry = { readonly version: 1; readonly servers: readonly ServerEntry[] };

const LABEL = "perch/mcp-servers/v1";
export const EMPTY: Registry = { version: 1, servers: [] };

export function findServer(reg: Registry, name: string): ServerEntry | undefined {
  return reg.servers.find((s) => s.name === name);
}

export function addServer(reg: Registry, entry: ServerEntry): Registry {
  if (findServer(reg, entry.name)) throw new Error(`a server named "${entry.name}" already exists`);
  return { ...reg, servers: [...reg.servers, parseEntry(entry)] };
}

export function removeServer(reg: Registry, name: string): Registry {
  return { ...reg, servers: reg.servers.filter((s) => s.name !== name) };
}

export type EntryPatch = Partial<Pick<ServerEntry, "enabled" | "trusted" | "approvedLaunch" | "config">>;

export function updateServer(reg: Registry, name: string, patch: EntryPatch): Registry {
  if (!findServer(reg, name)) throw new Error(`no server named "${name}"`);
  return { ...reg, servers: reg.servers.map((s) => (s.name === name ? parseEntry({ ...s, ...patch }) : s)) };
}

/** A name not yet used in the registry: github, github-2, github-3, ... */
export function freeName(reg: Registry, name: string, taken: ReadonlySet<string> = new Set()): string {
  const used = (n: string) => Boolean(findServer(reg, n)) || taken.has(n);
  if (!used(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name.slice(0, 29)}-${i}`;
    if (!used(candidate)) return candidate;
  }
}

export class RegistryStore {
  constructor(
    readonly path: string,
    private readonly keychain: SecretStore,
  ) {}

  async load(): Promise<Registry> {
    const raw = await readSealedJson<{ version?: number; servers?: unknown[] }>(this.path, await dataKey(this.keychain), LABEL);
    if (!raw) return EMPTY;
    if (raw.version !== 1 || !Array.isArray(raw.servers)) throw new Error("the MCP server settings are in an unknown format");
    return { version: 1, servers: raw.servers.map(parseEntry) };
  }

  async save(reg: Registry): Promise<void> {
    await writeSealedJson(this.path, await dataKey(this.keychain), LABEL, reg);
  }
}
