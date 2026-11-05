/**
 * The sync keys' life on a device: create the first one, load them, recover them, hand them to a
 * paired device, and rotate after a device is removed. A device holds every key version (newest
 * first in use), so items written before a rotation stay readable until they are re-encrypted.
 * Trust in other devices' public keys and in the recovery public key comes from pairing (a code
 * the person carries between screens) or from recovery, never from the server alone.
 */
import type { SyncApi, PairingLookup, PairingStart } from "./api";
import { deriveSyncKeys, newSyncKey, type SyncKeys } from "./crypto";
import type { Keyring } from "./engine";
import { decodeKeys, encodeKeys, unwrapForDevice, wrapForDevice, type DeviceKeys, type VersionedKey } from "./keys";
import { keyMatchesCode, newPairingCode, openGrant, parsePairingCode, sealGrant, type PairingCode } from "./pairing";
import { createRecoveryKit, newRecoveryKey, openRecovery, recoveryBlob, recoveryKitFrom, RECOVERY_ITERATIONS } from "./recovery";
import type { DeviceInfo, SessionGrant } from "./types";

export type { VersionedKey } from "./keys";
export type ThisDevice = { id: string; keys: DeviceKeys };
export type TrustedDevice = { id: string; publicKey: string };

const newest = (keys: readonly VersionedKey[]) => Math.max(...keys.map((k) => k.version));
const wrapAll = (keys: readonly VersionedKey[], publicKey: string, slot: string) => wrapForDevice(encodeKeys(keys), publicKey, slot, newest(keys));

/** First device: makes the sync key (version 1) and the recovery key the person must write down. */
export async function createSyncKey(api: SyncApi, device: ThisDevice, options: { recoveryKey?: string; iterations?: number } = {}) {
  const info = await api.keys();
  if (info.keyVersion !== 0) throw new Error("This account already has sync data. Pair with another device or enter the recovery key.");
  const keys: VersionedKey[] = [{ version: 1, raw: newSyncKey() }];
  const recoveryKey = options.recoveryKey ?? newRecoveryKey();
  const kit = await createRecoveryKit(recoveryKey, options.iterations ?? RECOVERY_ITERATIONS);
  await api.rotateKey(1, { [device.id]: await wrapAll(keys, device.keys.publicKey, device.id) }, await recoveryBlob(keys, kit));
  return { keys, recoveryKey, recoveryPublicKey: kit.publicKey };
}

/** This device's copy of the current keys, or null if no device has granted it one yet. */
export async function loadSyncKeys(api: SyncApi, device: ThisDevice): Promise<VersionedKey[] | null> {
  const info = await api.keys();
  if (!info.device || info.device.version !== info.keyVersion) return null;
  return decodeKeys(await unwrapForDevice(info.device.blob, device.keys, device.id, info.device.version), info.device.version);
}

/** Opens the recovery copy with the recovery key and grants this device its own copy. */
export async function recoverSyncKey(api: SyncApi, device: ThisDevice, recoveryKey: string) {
  const info = await api.keys();
  if (!info.recovery || info.recovery.version !== info.keyVersion) throw new Error("This account has no recovery copy for its current sync key.");
  const { keys, publicKey } = await openRecovery(info.recovery.blob, recoveryKey, info.recovery.version);
  await api.grantKey(device.id, info.keyVersion, await wrapAll(keys, device.keys.publicKey, device.id));
  return { keys, recoveryPublicKey: publicKey };
}

/**
 * Approves a device waiting to pair. The code the person typed or scanned must commit to the
 * public key the server returned; otherwise the server (or someone else) swapped the key. The
 * grant tells the new device who approved and the recovery public key; only browsers get the keys
 * (a remote CLI only needs the relay).
 */
export async function approvePairing(
  api: SyncApi,
  lookup: PairingLookup,
  typedCode: string,
  from: { device: ThisDevice; keys?: readonly VersionedKey[]; recoveryPublicKey?: string },
) {
  const code = parsePairingCode(typedCode);
  if (code.lookup !== lookup.code || !(await keyMatchesCode(lookup.publicKey, code))) {
    throw new Error("The device's key does not match the code. Do not approve; start pairing again.");
  }
  const grant = await sealGrant(
    {
      approver: { id: from.device.id, publicKey: from.device.keys.publicKey },
      ...(from.recoveryPublicKey ? { recoveryPublicKey: from.recoveryPublicKey } : {}),
      ...(from.keys && lookup.kind === "browser" ? { keys: [...from.keys] } : {}),
    },
    lookup.publicKey,
    code.secret,
    lookup.pairingId,
  );
  const approved = await api.approvePairing(lookup.pairingId, grant);
  return { deviceId: approved.deviceId, trusted: { id: approved.deviceId, publicKey: lookup.publicKey } as TrustedDevice };
}

export type PendingPairing = { start: PairingStart; code: PairingCode };

/** New device: asks to pair and returns the code to show (`code.display`, or pairingQrPayload). */
export async function startPairing(api: SyncApi, info: DeviceInfo): Promise<PendingPairing> {
  const code = await newPairingCode(info.publicKey);
  return { start: await api.startPairing(info, code.lookup), code };
}

export type Paired = SessionGrant & { trusted: TrustedDevice[]; recoveryPublicKey?: string; keys?: VersionedKey[] };

/**
 * New device: polls once. When approved, opens the grant, trusts only the approver key inside it,
 * and stores its own copy of the sync keys. Returns null while the request is still waiting.
 */
export async function completePairing(api: SyncApi, pending: PendingPairing, keys: DeviceKeys): Promise<Paired | null> {
  const polled = await api.pollPairing(pending.start);
  if (polled.status !== "approved") return null;
  const grant = await openGrant(polled.grant, keys, pending.code.secret, pending.start.pairingId);
  if (grant.approver.id !== polled.approverDeviceId) throw new Error("The approval could not be verified. Do not use this pairing; start again.");
  const session: SessionGrant = { sessionToken: polled.sessionToken, accountId: polled.accountId, deviceId: polled.deviceId };
  if (grant.keys?.length) {
    await api.withToken(session.sessionToken).grantKey(session.deviceId, newest(grant.keys), await wrapAll(grant.keys, keys.publicKey, session.deviceId));
  }
  return {
    ...session,
    trusted: [grant.approver],
    ...(grant.recoveryPublicKey ? { recoveryPublicKey: grant.recoveryPublicKey } : {}),
    ...(grant.keys?.length ? { keys: grant.keys } : {}),
  };
}

/**
 * After removing a device: a new key version, wrapped (with every older version) for the trusted
 * devices still on the account and for recovery, checked against the pinned recovery public key.
 * Refuses rather than silently dropping the recovery copy when this device has no pinned key.
 * Then run SyncEngine.reencrypt on each collection to move items to the new key.
 */
export async function rotateSyncKey(
  api: SyncApi,
  device: ThisDevice,
  trusted: readonly TrustedDevice[],
  current: { keys: readonly VersionedKey[]; recoveryPublicKey?: string },
): Promise<VersionedKey[]> {
  const [info, listed] = await Promise.all([api.keys(), api.devices()]);
  if (info.recovery && !current.recoveryPublicKey) {
    throw new Error("This device cannot update the recovery copy, so changing the sync key here would stop the recovery key working. Enter the recovery key on this device first, or change the key on the Mac that set up sync.");
  }
  if (!current.keys.length || newest(current.keys) !== info.keyVersion) {
    throw new Error("Another device changed the sync key. Fetch the new key on this device, then try again.");
  }
  const live = new Map(listed.filter((d) => d.kind === "browser").map((d) => [d.id, d.publicKey]));
  const keys = [...current.keys, { version: info.keyVersion + 1, raw: newSyncKey() }];
  const recipients = [{ id: device.id, publicKey: device.keys.publicKey }, ...trusted.filter((t) => t.id !== device.id && live.get(t.id) === t.publicKey)];
  const wraps = Object.fromEntries(await Promise.all(recipients.map(async (r) => [r.id, await wrapAll(keys, r.publicKey, r.id)] as const)));
  const recovery = info.recovery && current.recoveryPublicKey ? await recoveryBlob(keys, recoveryKitFrom(info.recovery.blob, current.recoveryPublicKey)) : undefined;
  await api.rotateKey(newest(keys), wraps, recovery);
  return keys;
}

/** Builds the engine's keyring from every key version this device holds. */
export async function makeKeyring(keys: readonly VersionedKey[]): Promise<Keyring> {
  if (!keys.length) throw new Error("No sync key");
  const derived = new Map<number, SyncKeys>();
  for (const key of keys) derived.set(key.version, await deriveSyncKeys(key.raw, key.version));
  const top = Math.max(...derived.keys());
  return { current: derived.get(top)!, byVersion: (version) => derived.get(version) };
}
