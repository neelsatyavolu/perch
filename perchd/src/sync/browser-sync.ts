/**
 * Sync inside Perch (plan 3b task 14): this device's account in the Keychain, pairing with a
 * device that already syncs (a QR code and a typed code), and a pass over the browser's bookmarks,
 * history and open tabs every 15 minutes while sync is on. Sync is on when the Keychain holds a
 * session for this device; turning it off deletes that session and this device's keys.
 *
 * Passwords and extensions do not sync until Chromium's sync protocol lands (sync plan, deferred).
 */

import { fromBase64Url, toBase64Url } from "./encoding";
import { emptySyncState, SyncEngine, type SyncState } from "./engine";
import { SyncApi } from "./api";
import { completePairing, loadSyncKeys, makeKeyring, startPairing, type PendingPairing, type ThisDevice, type TrustedDevice, type VersionedKey } from "./keyring";
import { exportDeviceKeys, generateDeviceKeys, importDeviceKeys, type DeviceKeys } from "./keys";
import type { SecretStore } from "./keychain";
import { pairingQrPayload } from "./pairing";
import { syncOnce, type SyncAdapter, type SyncRun } from "./runner";
import { bookmarksAdapter, emptyBrowserState, historyAdapter, tabsAdapter, type BrowserSyncState, type StateCell } from "./browser-adapters";
import type { PerchDomainApi } from "../browser/perch-domain";
import { join } from "node:path";
import { syncAllowed, syncBaseUrl, type PolicyView } from "../policy/policy";
import { MacKeychain, type SecretStore as SealKeychain } from "../secure/keychain";
import { dataKey, readSealedJson, writeSealedJson } from "../secure/sealed";

export const SYNC_INTERVAL_MS = 15 * 60_000;

type Domain = Pick<PerchDomainApi, "getBookmarks" | "applyBookmarkChanges" | "getHistory" | "addHistory" | "getOpenTabs">;

export type SavedState = BrowserSyncState & { readonly sync: SyncState };
export type StateFile = { load(): Promise<SavedState | null>; save(state: SavedState): Promise<void> };

export type Account = { session: { sessionToken: string; accountId: string; deviceId: string }; device: ThisDevice; trusted: TrustedDevice[]; keys: VersionedKey[] | null; recoveryPublicKey?: string };

export type SyncDevice = { id: string; name: string; kind: string; lastSeen: string; current: boolean };
export type SyncStatus = { on: boolean; lastSync: string | null; lastError: string | null; devices: SyncDevice[] };
export type Pairing = { pairingId: string; qr: string; code: string; expiresAt: string };

export type BrowserSyncOptions = {
  domain: Domain;
  secrets: SecretStore;
  /** The sync server, without a session; the service adds this device's token. */
  api: SyncApi;
  state: StateFile;
  /** Company policy: false stops passes (asked before each collection too). */
  allowed?: () => boolean;
  deviceName?: string;
  intervalMs?: number;
  now?: () => number;
  pairing?: { start: typeof startPairing; complete: typeof completePairing };
};

const SESSION = "session-token";
const DEVICE_KEYS = "device-keys";
const SYNC_KEYS = "sync-keys";
const RECOVERY_PUBLIC = "recovery-public-key";

const encodeKeyList = (keys: readonly VersionedKey[]) => JSON.stringify(keys.map((k) => ({ version: k.version, raw: toBase64Url(k.raw) })));
const decodeKeyList = (text: string): VersionedKey[] => (JSON.parse(text) as { version: number; raw: string }[]).map((k) => ({ version: k.version, raw: fromBase64Url(k.raw) }));

export class BrowserSync {
  private readonly pending = new Map<string, { pending: PendingPairing; keys: DeviceKeys }>();
  private lastSync: string | null = null;
  private lastError: string | null = null;
  private running: Promise<SyncRun | null> | null = null;

  constructor(private readonly opts: BrowserSyncOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async account(): Promise<Account | null> {
    const [sessionText, deviceText] = await Promise.all([this.opts.secrets.get(SESSION), this.opts.secrets.get(DEVICE_KEYS)]);
    if (!sessionText || !deviceText) return null;
    const saved = JSON.parse(sessionText) as Account["session"] & { trusted?: TrustedDevice[] };
    const [keysText, recovery] = await Promise.all([this.opts.secrets.get(SYNC_KEYS), this.opts.secrets.get(RECOVERY_PUBLIC)]);
    return {
      session: { sessionToken: saved.sessionToken, accountId: saved.accountId, deviceId: saved.deviceId },
      device: { id: saved.deviceId, keys: await importDeviceKeys(deviceText) },
      trusted: saved.trusted ?? [],
      keys: keysText ? decodeKeyList(keysText) : null,
      ...(recovery ? { recoveryPublicKey: recovery } : {}),
    };
  }

  async status(): Promise<SyncStatus> {
    const account = await this.account();
    if (!account) return { on: false, lastSync: null, lastError: null, devices: [] };
    let devices: SyncDevice[] = [];
    try {
      devices = (await this.opts.api.withToken(account.session.sessionToken).devices()).map((d) => ({
        id: d.id, name: d.name, kind: d.kind, lastSeen: new Date(d.lastSeenAt).toISOString(), current: d.id === account.session.deviceId,
      }));
    } catch (error) {
      this.lastError = `Perch couldn't reach the sync server: ${(error as Error).message}`;
    }
    return { on: true, lastSync: this.lastSync, lastError: this.lastError, devices };
  }

  /** This device asks to join: the QR and code to show. Another Perch that syncs approves it. */
  async startPairing(): Promise<Pairing> {
    if (await this.account()) throw new Error("Sync is already on for this Mac.");
    const keys = await generateDeviceKeys();
    const start = this.opts.pairing?.start ?? startPairing;
    const pending = await start(this.opts.api, { name: this.opts.deviceName ?? "Perch on this Mac", kind: "browser", publicKey: keys.publicKey });
    this.pending.set(pending.start.pairingId, { pending, keys });
    return { pairingId: pending.start.pairingId, qr: pairingQrPayload(pending.code), code: pending.code.display, expiresAt: new Date(pending.start.expiresAt).toISOString() };
  }

  /** Polls once. True when the other device approved and sync is on; false while it waits. */
  async checkPairing(pairingId: string): Promise<boolean> {
    const entry = this.pending.get(pairingId);
    if (!entry) throw new Error("This pairing has ended. Start again.");
    if (entry.pending.start.expiresAt < this.now()) {
      this.pending.delete(pairingId);
      throw new Error("The code expired. Start again.");
    }
    const complete = this.opts.pairing?.complete ?? completePairing;
    const paired = await complete(this.opts.api, entry.pending, entry.keys);
    if (!paired) return false;
    this.pending.delete(pairingId);
    const { sessionToken, accountId, deviceId } = paired;
    await this.opts.secrets.set(DEVICE_KEYS, await exportDeviceKeys(entry.keys));
    if (paired.keys?.length) await this.opts.secrets.set(SYNC_KEYS, encodeKeyList(paired.keys));
    if (paired.recoveryPublicKey) await this.opts.secrets.set(RECOVERY_PUBLIC, paired.recoveryPublicKey);
    // Written last: the session is what turns sync on, so a crash midway leaves it off.
    await this.opts.secrets.set(SESSION, JSON.stringify({ sessionToken, accountId, deviceId, trusted: paired.trusted }));
    this.lastError = null;
    return true;
  }

  /** One pass now; a pass already running is joined, not doubled. Null when sync is off or not allowed. */
  syncNow(): Promise<SyncRun | null> {
    this.running ??= this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private async keysFor(account: Account, api: SyncApi): Promise<VersionedKey[] | null> {
    if (account.keys?.length) return account.keys;
    const keys = await loadSyncKeys(api, account.device);
    if (keys) await this.opts.secrets.set(SYNC_KEYS, encodeKeyList(keys));
    return keys;
  }

  /** The adapters whose browser methods this Perch has. */
  private async adapters(cell: StateCell, deviceId: string): Promise<SyncAdapter[]> {
    const d = this.opts.domain;
    const [bookmarks, history, tabs] = await Promise.all([d.getBookmarks(), d.getHistory({ since: this.now(), max: 1 }), d.getOpenTabs()]);
    return [
      ...(bookmarks ? [bookmarksAdapter(d, cell, () => this.now())] : []),
      ...(history ? [historyAdapter(d, cell)] : []),
      ...(tabs ? [tabsAdapter(d, cell, deviceId, () => this.now())] : []),
    ];
  }

  private async pass(): Promise<SyncRun | null> {
    if (this.opts.allowed && !this.opts.allowed()) return null;
    const account = await this.account();
    if (!account) return null;
    try {
      const api = this.opts.api.withToken(account.session.sessionToken);
      let keys = await this.keysFor(account, api);
      if (!keys) {
        this.lastError = "Waiting for another device to share the sync key. Open Perch there.";
        return null;
      }
      const saved = (await this.opts.state.load()) ?? { ...emptyBrowserState, sync: emptySyncState };
      let browser: BrowserSyncState = saved;
      const cell: StateCell = { get: () => browser, set: (s) => (browser = s) };
      const adapters = await this.adapters(cell, account.session.deviceId);
      let run = await syncOnce(new SyncEngine(api, await makeKeyring(keys), account.session.deviceId), saved.sync, adapters, this.opts.allowed);
      if (run.keyChanged !== undefined) {
        // Another device rotated the key: fetch this device's copy and go again once.
        keys = await loadSyncKeys(api, account.device);
        if (!keys) throw new Error("The sync key changed on another device and this Mac has no copy yet. Open Perch on that device.");
        await this.opts.secrets.set(SYNC_KEYS, encodeKeyList(keys));
        run = await syncOnce(new SyncEngine(api, await makeKeyring(keys), account.session.deviceId), run.state, adapters, this.opts.allowed);
      }
      await this.opts.state.save({ ...browser, sync: run.state });
      this.lastSync = new Date(this.now()).toISOString();
      this.lastError = run.failed.length ? `${run.failed.length} item${run.failed.length === 1 ? "" : "s"} did not fit in your sync storage.` : null;
      return run;
    } catch (error) {
      this.lastError = `Sync failed: ${(error as Error).message}`;
      return null;
    }
  }

  async removeDevice(id: string): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("Sync is off.");
    if (id === account.session.deviceId) throw new Error("To stop syncing this Mac, turn sync off.");
    await this.opts.api.withToken(account.session.sessionToken).revokeDevice(id);
    const trusted = account.trusted.filter((t) => t.id !== id);
    await this.opts.secrets.set(SESSION, JSON.stringify({ ...account.session, trusted }));
  }

  /** Signs this device out and deletes its keys. Synced data stays in the browser. */
  async turnOff(): Promise<void> {
    const account = await this.account();
    if (account) await this.opts.api.withToken(account.session.sessionToken).revokeDevice(account.session.deviceId).catch(() => undefined);
    for (const name of [SESSION, SYNC_KEYS, DEVICE_KEYS, RECOVERY_PUBLIC]) await this.opts.secrets.delete(name);
    this.lastSync = null;
    this.lastError = null;
  }

  /** A pass now and every 15 minutes while sync is on. Returns a function that stops it. */
  start(): () => void {
    const tick = () => void this.syncNow();
    tick();
    const timer = setInterval(tick, this.opts.intervalMs ?? SYNC_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

const STATE_LABEL = "perch/sync/browser-state/v1";

/** The pass state in one file sealed under a data key from the Keychain. It holds bookmark fingerprints and other devices' open tabs. */
export function sealedStateFile(path: string, keychain: SealKeychain): StateFile {
  return {
    load: async () => readSealedJson<SavedState>(path, await dataKey(keychain), STATE_LABEL),
    save: async (state) => writeSealedJson(path, await dataKey(keychain), STATE_LABEL, state),
  };
}

/**
 * perchd inside Perch: sync over the browser's data, on its 15-minute timer, only while sync is on
 * and the company policy allows it. Returns the service (for Settings › Sync) and a stop function.
 */
export function startBrowserSync(opts: { domain: Domain; dataDir: string; policy?: PolicyView; keychain?: SealKeychain; deviceName?: string }): { sync: BrowserSync; stop: () => void } {
  const keychain = opts.keychain ?? new MacKeychain({ service: "co.xanom.perch.sync" });
  const policy = () => opts.policy?.current() ?? {};
  const sync = new BrowserSync({
    domain: opts.domain,
    secrets: keychain,
    api: new SyncApi({ baseUrl: syncBaseUrl(policy()) }),
    state: sealedStateFile(join(opts.dataDir, "sync", "browser-state.sealed"), keychain),
    allowed: () => syncAllowed(policy()),
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
  return { sync, stop: sync.start() };
}
