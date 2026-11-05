/**
 * The sync key's life on a device: create it on the first device, load it, recover it, hand it to a
 * paired device, and rotate it after a device is removed. Trust in other devices' public keys
 * comes from pairing (the code is a hash of the key) or from the person checking a fingerprint,
 * never from the server alone; callers pass the keys they trust.
 */
import type { SyncApi, PairingLookup } from "./api";
import { deriveSyncKeys, newSyncKey, type SyncKeys } from "./crypto";
import { normalizeCode, pairingCode, safeEqual, type Bytes } from "./encoding";
import type { Keyring } from "./engine";
import { unwrapForDevice, wrapForDevice, type DeviceKeys } from "./keys";
import { createRecoveryKit, newRecoveryKey, openRecovery, recoveryBlob, recoveryKitFrom, RECOVERY_ITERATIONS } from "./recovery";

export type ThisDevice = { id: string; keys: DeviceKeys };
export type VersionedKey = { version: number; raw: Bytes };
export type TrustedDevice = { id: string; publicKey: string };

/** First device: makes the sync key (version 1) and the recovery key the person must write down. */
export async function createSyncKey(api: SyncApi, device: ThisDevice, options: { recoveryKey?: string; iterations?: number } = {}) {
  const info = await api.keys();
  if (info.keyVersion !== 0) throw new Error("This account already has sync data. Pair with another device or enter the recovery key.");
  const raw = newSyncKey();
  const recoveryKey = options.recoveryKey ?? newRecoveryKey();
  const kit = await createRecoveryKit(recoveryKey, options.iterations ?? RECOVERY_ITERATIONS);
  await api.rotateKey(1, { [device.id]: await wrapForDevice(raw, device.keys.publicKey, device.id, 1) }, await recoveryBlob(raw, 1, kit));
  return { key: { version: 1, raw } as VersionedKey, recoveryKey, recoveryPublicKey: kit.publicKey };
}

/** This device's copy of the current key, or null if no device has granted it one yet. */
export async function loadSyncKey(api: SyncApi, device: ThisDevice): Promise<VersionedKey | null> {
  const info = await api.keys();
  if (!info.device || info.device.version !== info.keyVersion) return null;
  return { version: info.device.version, raw: await unwrapForDevice(info.device.blob, device.keys, device.id, info.device.version) };
}

/** Opens the recovery copy with the recovery key and grants this device its own copy. */
export async function recoverSyncKey(api: SyncApi, device: ThisDevice, recoveryKey: string) {
  const info = await api.keys();
  if (!info.recovery || info.recovery.version !== info.keyVersion) throw new Error("This account has no recovery copy for its current sync key.");
  const { syncKey, publicKey } = await openRecovery(info.recovery.blob, recoveryKey, info.recovery.version);
  await api.grantKey(device.id, info.keyVersion, await wrapForDevice(syncKey, device.keys.publicKey, device.id, info.keyVersion));
  return { key: { version: info.keyVersion, raw: syncKey } as VersionedKey, recoveryPublicKey: publicKey };
}

/**
 * Approves a device waiting to pair. The code the person typed or scanned must match the hash of
 * the public key the server returned; otherwise the server (or someone else) swapped the key.
 */
export async function approvePairing(api: SyncApi, lookup: PairingLookup, typedCode: string, key?: VersionedKey) {
  if (!safeEqual(await pairingCode(lookup.publicKey), normalizeCode(typedCode))) {
    throw new Error("The device's key does not match the code. Do not approve; start pairing again.");
  }
  const approved = await api.approvePairing(lookup.pairingId);
  // Only browsers get the sync key; a remote CLI only needs the relay. The wrap names the new
  // device id, which exists once approved.
  if (key && lookup.kind === "browser") {
    await api.grantKey(approved.deviceId, key.version, await wrapForDevice(key.raw, lookup.publicKey, approved.deviceId, key.version));
  }
  return { deviceId: approved.deviceId, trusted: { id: approved.deviceId, publicKey: lookup.publicKey } as TrustedDevice };
}

/**
 * After removing a device: a new key version, wrapped for the trusted devices still on the
 * account and for recovery (checked against the pinned recovery public key). Items are
 * re-encrypted by syncing them again with the new key.
 */
export async function rotateSyncKey(api: SyncApi, device: ThisDevice, trusted: TrustedDevice[], recoveryPublicKey?: string): Promise<VersionedKey> {
  const [info, listed] = await Promise.all([api.keys(), api.devices()]);
  const live = new Map(listed.filter((d) => d.kind === "browser").map((d) => [d.id, d.publicKey]));
  const version = info.keyVersion + 1;
  const raw = newSyncKey();
  const recipients = [{ id: device.id, publicKey: device.keys.publicKey }, ...trusted.filter((t) => t.id !== device.id && live.get(t.id) === t.publicKey)];
  const wraps = Object.fromEntries(await Promise.all(recipients.map(async (r) => [r.id, await wrapForDevice(raw, r.publicKey, r.id, version)] as const)));
  const recovery = info.recovery && recoveryPublicKey ? await recoveryBlob(raw, version, recoveryKitFrom(info.recovery.blob, recoveryPublicKey)) : undefined;
  await api.rotateKey(version, wraps, recovery);
  return { version, raw };
}

/** Builds the engine's keyring from the current key and any older ones still kept. */
export async function makeKeyring(keys: VersionedKey[]): Promise<Keyring> {
  if (!keys.length) throw new Error("No sync key");
  const derived = new Map<number, SyncKeys>();
  for (const key of keys) derived.set(key.version, await deriveSyncKeys(key.raw, key.version));
  const newest = Math.max(...derived.keys());
  return { current: derived.get(newest)!, byVersion: (version) => derived.get(version) };
}
