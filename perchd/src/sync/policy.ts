/**
 * Sync and remote control under company policy (spec 12.2): SyncEnabled (or Chrome's SyncDisabled)
 * turns sync off, SyncServerURL points it at the company's server, and RemoteControlEnabled false
 * keeps the relay closed and closes an open one when the policy changes.
 */

import { ManagedError, remoteControlAllowed, syncAllowed, syncBaseUrl, type Policy, type PolicyView } from "../policy/policy";
import { SyncApi, type FetchLike } from "./api";

export const SYNC_OFF = "Your organization turned off sync.";
export const REMOTE_OFF = "Your organization turned off remote control.";

/** The sync client for the current policy; refuses when sync is off. */
export function managedSyncApi(policy: Policy, options: { fetch?: FetchLike; token?: string } = {}): SyncApi {
  if (!syncAllowed(policy)) throw new ManagedError(SYNC_OFF);
  return new SyncApi({ ...options, baseUrl: syncBaseUrl(policy) });
}

/** Throws before a relay connection when remote control is off. */
export function checkRemoteControl(policy: Policy): void {
  if (!remoteControlAllowed(policy)) throw new ManagedError(REMOTE_OFF);
}

type Watched = PolicyView & { onChange(listener: (policy: Policy) => void): () => void };

/** Closes `relay` as soon as a policy change turns remote control off. Returns a function that stops watching. */
export function closeRelayWhenOff(relay: { close(): void }, watcher: Watched): () => void {
  return watcher.onChange((policy) => {
    if (!remoteControlAllowed(policy)) relay.close();
  });
}
