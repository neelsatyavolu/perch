/**
 * Settings → Models choices, encrypted at rest (spec 11.1): which providers are connected, their
 * base URLs, the task model roles and the last model used. Secrets are never stored here; they
 * live in the Keychain. The file key is a random 256-bit key, also in the Keychain.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProviderId, isRole, isRoleEffort, type ModelRef, type ProviderId, type Role, type RoleChoice } from "../models/ids";
import { newKey, open, seal } from "./crypto";
import type { Keychain } from "./keychain";

export const SETTINGS_FILE = "models.settings";
export const SETTINGS_KEY_NAME = "settings-key";

export type ProviderSettings = { connected: boolean; baseUrl?: string };
export type Settings = {
  version: 1;
  providers: Partial<Record<ProviderId, ProviderSettings>>;
  roles: Partial<Record<Role, RoleChoice>>;
  lastUsed?: ModelRef;
};

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function defaultSettings(): Settings {
  return { version: 1, providers: {}, roles: {} };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only http(s), and plain http only for this Mac (local model servers). */
export function checkBaseUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new SettingsError("The base URL is not a valid address.");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SettingsError("The base URL must use https, or http on this Mac (localhost).");
  }
  if (url.username || url.password) throw new SettingsError("Put credentials in the key field, not in the base URL.");
  return url.toString().replace(/\/+$/, "");
}

function parseModelRef(v: unknown, where: string): ModelRef {
  if (!isObject(v)) throw new SettingsError(`${where} must be an object.`);
  if (!isProviderId(v.provider)) throw new SettingsError(`${where} names an unknown provider.`);
  if (typeof v.model !== "string" || !v.model.trim() || v.model.length > 200) throw new SettingsError(`${where} needs a model id.`);
  return { provider: v.provider, model: v.model };
}

function parseRoleChoice(v: unknown, role: string): RoleChoice {
  const ref = parseModelRef(v, `The ${role} role`);
  const raw = v as Record<string, unknown>;
  if (raw.effort !== undefined && !isRoleEffort(raw.effort)) throw new SettingsError(`The ${role} role has an unknown effort.`);
  if (raw.fast !== undefined && typeof raw.fast !== "boolean") throw new SettingsError(`The ${role} role's fast setting must be true or false.`);
  return { ...ref, ...(raw.effort !== undefined ? { effort: raw.effort as RoleChoice["effort"] } : {}), ...(raw.fast !== undefined ? { fast: raw.fast as boolean } : {}) };
}

function parseProviders(v: unknown): Settings["providers"] {
  if (!isObject(v)) throw new SettingsError("providers must be an object.");
  const out: Settings["providers"] = {};
  for (const [id, entry] of Object.entries(v)) {
    if (!isProviderId(id)) throw new SettingsError(`Unknown provider "${id}".`);
    if (!isObject(entry) || typeof entry.connected !== "boolean") throw new SettingsError(`Provider ${id} needs connected: true or false.`);
    out[id] = { connected: entry.connected, ...(entry.baseUrl !== undefined ? { baseUrl: checkBaseUrl(entry.baseUrl) } : {}) };
  }
  return out;
}

function parseRoles(v: unknown): Settings["roles"] {
  if (!isObject(v)) throw new SettingsError("roles must be an object.");
  const out: Settings["roles"] = {};
  for (const [role, choice] of Object.entries(v)) {
    if (!isRole(role)) throw new SettingsError(`Unknown role "${role}".`);
    out[role] = parseRoleChoice(choice, role);
  }
  return out;
}

/** Validates untrusted settings (a decrypted file, or an update) into a fresh object. */
export function parseSettings(v: unknown): Settings {
  if (!isObject(v) || v.version !== 1) throw new SettingsError("Unsupported settings version.");
  return {
    version: 1,
    providers: parseProviders(v.providers),
    roles: parseRoles(v.roles),
    ...(v.lastUsed !== undefined ? { lastUsed: parseModelRef(v.lastUsed, "The last used model") } : {}),
  };
}

function deepFreeze<T>(value: T): T {
  if (isObject(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class SettingsStore {
  private constructor(
    private readonly file: string,
    private readonly key: Uint8Array,
    private current: Settings,
    /** True when an unreadable file was set aside at open. */
    readonly recovered: boolean,
  ) {}

  static async open(opts: { dir: string; keychain: Keychain }): Promise<SettingsStore> {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    const file = join(opts.dir, SETTINGS_FILE);
    const stored = await opts.keychain.get(SETTINGS_KEY_NAME);
    let key = stored ? Buffer.from(stored, "base64") : null;
    if (key?.length !== 32) key = null;
    let settings = defaultSettings();
    let recovered = false;
    if (existsSync(file)) {
      try {
        if (!key) throw new SettingsError("The settings key is missing.");
        settings = parseSettings(JSON.parse(new TextDecoder().decode(open(key, readFileSync(file), SETTINGS_FILE))));
      } catch {
        // The file holds choices, not secrets: keep a copy aside and start again.
        renameSync(file, `${file}.unreadable-${Date.now()}`);
        settings = defaultSettings();
        recovered = true;
      }
    }
    if (!key) {
      key = Buffer.from(newKey());
      await opts.keychain.set(SETTINGS_KEY_NAME, key.toString("base64"));
    }
    return new SettingsStore(file, new Uint8Array(key), deepFreeze(settings), recovered);
  }

  get(): Settings {
    return this.current;
  }

  /** Applies a change; the result is validated and written before it becomes current. */
  async update(change: (current: Settings) => Settings): Promise<Settings> {
    const next = deepFreeze(parseSettings(change(this.current)));
    const sealed = seal(this.key, new TextEncoder().encode(JSON.stringify(next)), SETTINGS_FILE);
    const temp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temp, sealed, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.file);
    this.current = next;
    return next;
  }
}
