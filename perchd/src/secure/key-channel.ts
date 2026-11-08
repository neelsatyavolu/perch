/**
 * The browser's one-way channel to perchd on fd 5 (plan 3b, tasks 2 and 3). Lines are JSON:
 *   {op: "app", port, token, browserToken, origins, dataDir}   once, at launch
 *   {op: "profile", id, dir, key, protected, recovery?}         per profile: its 32-byte root key, base64
 *   {op: "profile-removed", id}
 * The root key exists only here, in memory. perchd derives one key per store from it with HKDF,
 * and never writes, logs or sends it. EOF means "flush and exit", and every key is zeroed.
 */

import { hkdfSync } from "node:crypto";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";

export type BrowserSettings = { port: number; token: string; browserToken: string; origins: string[]; dataDir: string };

/** Every store that takes a key from the profile's root key. The name is part of the HKDF info. */
export const KEY_STORES = ["app", "config", "daemon", "import", "memory", "sync", "secure", "authenticator", "audit"] as const;
export type KeyStoreName = (typeof KEY_STORES)[number];

const ROOT_BYTES = 32;
const PROFILE_ID = /^[A-Za-z0-9 ._-]{1,64}$/;
const MAX_RECOVERY = 4096;

export class KeySource {
  private root: Buffer | null;

  constructor(root: Buffer) {
    if (root.length !== ROOT_BYTES) throw new Error("a profile root key must be 32 bytes");
    this.root = root;
  }

  /** HKDF-SHA256 over the root key, no salt, info `perch/<store>/v1`, 32 bytes. */
  derive(store: KeyStoreName): Buffer {
    if (!(KEY_STORES as readonly string[]).includes(store)) throw new Error("unknown key store");
    if (!this.root) throw new Error("this profile's key is gone");
    return Buffer.from(hkdfSync("sha256", this.root, Buffer.alloc(0), `perch/${store}/v1`, 32));
  }

  destroy(): void {
    this.root?.fill(0);
    this.root = null;
  }
}

export type ProfileKeys = {
  readonly id: string;
  readonly dir: string;
  /** False when the browser's key helper had no Secure Enclave key (an unsigned development build). */
  readonly protected: boolean;
  /** The root key encrypted under the user's recovery key, sent once when the key is first made. */
  readonly recovery?: Buffer;
  readonly source: KeySource;
};

export type ChannelLine =
  | { op: "app"; settings: BrowserSettings }
  | { op: "profile"; id: string; dir: string; protected: boolean; recovery?: Buffer; key: Buffer }
  | { op: "profile-removed"; id: string };

export function parseBrowserSettings(o: Record<string, unknown>): BrowserSettings {
  const port = o.port;
  if (o.op !== "app" || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad port");
  if (typeof o.token !== "string" || o.token.length < 32) throw new Error("bad token");
  if (typeof o.browserToken !== "string" || o.browserToken.length < 32 || o.browserToken === o.token) throw new Error("bad browser token");
  if (typeof o.dataDir !== "string" || !o.dataDir.startsWith("/")) throw new Error("bad data folder");
  const origins = Array.isArray(o.origins) ? o.origins.filter((x): x is string => typeof x === "string" && /^chrome(-untrusted)?:\/\/[a-z0-9.-]+$/.test(x)) : [];
  return { port, token: o.token, browserToken: o.browserToken, origins, dataDir: o.dataDir };
}

function strictBase64(value: unknown, what: string, max: number): Buffer {
  if (typeof value !== "string" || value.length > max * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`bad ${what}`);
  return Buffer.from(value, "base64");
}

function parseProfile(o: Record<string, unknown>): ChannelLine {
  if (typeof o.id !== "string" || !PROFILE_ID.test(o.id) || o.id.includes("..")) throw new Error("bad profile id");
  if (typeof o.dir !== "string" || !o.dir.startsWith("/")) throw new Error("bad profile folder");
  const key = strictBase64(o.key, "key", ROOT_BYTES);
  if (key.length !== ROOT_BYTES) {
    key.fill(0);
    throw new Error("bad key");
  }
  const recovery = o.recovery === undefined ? undefined : strictBase64(o.recovery, "recovery", MAX_RECOVERY);
  if (recovery && (recovery.length === 0 || recovery.length > MAX_RECOVERY)) throw new Error("bad recovery");
  return { op: "profile", id: o.id, dir: o.dir, protected: o.protected === true, key, ...(recovery ? { recovery } : {}) };
}

/** Parses one line. Errors name the field, never its value. */
export function parseChannelLine(line: string): ChannelLine {
  const o = JSON.parse(line) as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("unknown line");
  switch (o.op) {
    case "app":
      return { op: "app", settings: parseBrowserSettings(o) };
    case "profile":
      return parseProfile(o);
    case "profile-removed":
      if (typeof o.id !== "string" || !PROFILE_ID.test(o.id)) throw new Error("bad profile id");
      return { op: "profile-removed", id: o.id };
    default:
      throw new Error("unknown line");
  }
}

export type KeyChannel = {
  /** The app line. Rejects if the browser closes the channel first. */
  readonly settings: Promise<BrowserSettings>;
  /** A profile's keys, waiting up to `waitMs` for them to arrive; null if they don't. */
  profile(id: string, waitMs: number): Promise<ProfileKeys | null>;
  /** Called when the browser removes a profile, after its keys are zeroed. */
  onRemoved(listener: (id: string) => void): void;
  /** Settles when the browser closes fd 5. */
  readonly closed: Promise<void>;
};

export function readKeyChannel(input: Readable, opts: { onProblem?: (message: string) => void } = {}): KeyChannel {
  let profiles: ReadonlyMap<string, ProfileKeys> = new Map();
  let waiters: ReadonlyArray<{ id: string; resolve: (k: ProfileKeys | null) => void }> = [];
  let removedListeners: ReadonlyArray<(id: string) => void> = [];
  let resolveSettings!: (s: BrowserSettings) => void;
  let rejectSettings!: (e: Error) => void;
  const settings = new Promise<BrowserSettings>((resolve, reject) => {
    resolveSettings = resolve;
    rejectSettings = reject;
  });
  settings.catch(() => undefined);

  const drop = (id: string) => {
    profiles.get(id)?.source.destroy();
    profiles = new Map([...profiles].filter(([k]) => k !== id));
  };

  const handle = (line: ChannelLine) => {
    if (line.op === "app") return resolveSettings(line.settings);
    if (line.op === "profile-removed") {
      drop(line.id);
      for (const listener of removedListeners) listener(line.id);
      return;
    }
    drop(line.id);
    const keys: ProfileKeys = { id: line.id, dir: line.dir, protected: line.protected, source: new KeySource(line.key), ...(line.recovery ? { recovery: line.recovery } : {}) };
    profiles = new Map([...profiles, [line.id, keys]]);
    const ready = waiters.filter((w) => w.id === line.id);
    waiters = waiters.filter((w) => w.id !== line.id);
    for (const w of ready) w.resolve(keys);
  };

  const closed = new Promise<void>((resolve) => {
    const done = () => {
      rejectSettings(new Error("the browser closed the settings pipe"));
      for (const id of profiles.keys()) drop(id);
      for (const w of waiters) w.resolve(null);
      waiters = [];
      resolve();
    };
    input.once("end", done);
    input.once("close", done);
    input.once("error", done);
  });

  const lines = createInterface({ input });
  lines.on("line", (raw) => {
    if (!raw.trim()) return;
    try {
      handle(parseChannelLine(raw));
    } catch (error) {
      opts.onProblem?.(`perchd: ignored a line from the browser (${(error as Error).message})`);
    }
  });

  return {
    settings,
    closed,
    onRemoved(listener) {
      removedListeners = [...removedListeners, listener];
    },
    profile(id, waitMs) {
      const ready = profiles.get(id);
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== waiter);
          resolve(null);
        }, waitMs);
        const waiter = {
          id,
          resolve: (k: ProfileKeys | null) => {
            clearTimeout(timer);
            resolve(k);
          },
        };
        waiters = [...waiters, waiter];
      });
    },
  };
}
