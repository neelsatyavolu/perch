/**
 * Settings › Sync (spec 11.3, plan 3b task 14): join an account by showing a QR code to a Perch
 * that already syncs, the devices on the account, and the recovery key behind Touch ID.
 */

import { useEffect, useState } from "preact/hooks";
import type { SyncDevice, SyncPairing, SyncStatus } from "../../api";
import { MANAGED_NOTE } from "../../lib/managed";
import { qrMatrix } from "../../lib/qr";
import { relativeTime } from "../../lib/time";
import { Dialog } from "../../ui/Dialog";
import { errorText, useAction, useApi, useLoad } from "../../ui/frame";
import { useManaged } from "../../ui/useManaged";
import { Group, Row } from "../../ui/Row";

/** How often a waiting pairing asks whether the other device approved it. */
export const PAIRING_POLL_MS = 1000;

const QUIET = 4;

/** The pairing payload as a QR code: dark modules on white, with the quiet zone readers need. */
export function QrCode({ text, label }: { readonly text: string; readonly label: string }) {
  const m = qrMatrix(text);
  const size = m.length + QUIET * 2;
  const path = m.flatMap((row, r) => row.map((on, c) => (on ? `M${c + QUIET} ${r + QUIET}h1v1h-1z` : ""))).join("");
  return (
    <svg class="qr" role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

const KIND: Readonly<Record<string, string>> = { browser: "Perch", cli: "perch CLI", assistant: "Assistant" };

function Pairing({ pairing, onPaired, onCancel }: { readonly pairing: SyncPairing; readonly onPaired: (s: SyncStatus) => void; readonly onCancel: () => void }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await api.checkSyncPairing(pairing.pairingId);
        if (!live) return;
        if (status) onPaired(status);
        else timer = setTimeout(poll, PAIRING_POLL_MS);
      } catch (e) {
        if (live) setError(errorText(e));
      }
    };
    timer = setTimeout(poll, PAIRING_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [pairing.pairingId]);
  return (
    <div class="card pairing" id="sync-pairing">
      <QrCode text={pairing.qr} label="Pairing code as a QR code" />
      <div class="pairing-text">
        <p>On a Mac where Perch already syncs, open Settings › Sync and choose Add a device. Scan this code, or type:</p>
        <p class="mono pairing-code" aria-label="Pairing code">{pairing.code}</p>
        {error ? (
          <p class="field-error" role="alert">{error}</p>
        ) : (
          <p class="note" aria-live="polite">Waiting for the other device. The code works until {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p>
        )}
        <button type="button" class="btn" onClick={onCancel}>{error ? "Start again" : "Cancel"}</button>
      </div>
    </div>
  );
}

export function RecoveryKey() {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setKey(null);
    setError(null);
  };
  const reveal = async () => {
    try {
      setKey(await api.revealRecoveryKey());
    } catch (e) {
      setError((e as { code?: string }).code === "unavailable" ? "This build of Perch can't show the recovery key. Use a signed Perch release." : errorText(e));
    }
  };
  return (
    <Group label="Recovery key" id="recovery-key">
      <div class="card">
        <Row title="Show recovery key" detail="The only way back into your synced data if you lose every device. Perch asks for Touch ID first">
          <button type="button" class="btn" onClick={() => setOpen(true)}>Show</button>
        </Row>
      </div>
      <Dialog
        open={open}
        title="Recovery key"
        onClose={close}
        footer={key ? (
          <button type="button" class="btn primary" onClick={close}>Done</button>
        ) : (
          <>
            <button type="button" class="btn" onClick={close}>Cancel</button>
            <button type="button" class="btn primary" onClick={reveal}>Show key</button>
          </>
        )}
      >
        {key ? (
          <>
            <p class="mono recovery" aria-label="Your recovery key">{key}</p>
            <p>Write it down and keep it somewhere safe, away from this Mac. Anyone with it can read your synced data.</p>
          </>
        ) : (
          <p>Make sure no one can see your screen. Perch will ask for Touch ID or your Mac's password.</p>
        )}
        {error && <p class="field-error" role="alert">{error}</p>}
      </Dialog>
    </Group>
  );
}

export function Sync() {
  const api = useApi();
  const act = useAction();
  const sync = useLoad((a) => a.getSync());
  const { locked } = useManaged();
  const [pairing, setPairing] = useState<SyncPairing | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [removing, setRemoving] = useState<SyncDevice | null>(null);
  const s = sync.data;
  if (!s) return <p class="mute">{sync.error ?? ""}</p>;
  const isLocked = locked("sync");
  const update = (next: SyncStatus | undefined) => next && sync.set(next);

  if (!s.on) {
    return (
      <div class="sec">
        <Group label="Sync" bare>
          {pairing ? (
            <Pairing pairing={pairing} onCancel={() => setPairing(null)} onPaired={(next) => { setPairing(null); sync.set(next); }} />
          ) : (
            <div class="card">
              <Row id="sync-on" title="Sync this Mac" detail={isLocked ? MANAGED_NOTE : "Bookmarks, history and open tabs, encrypted on this Mac before they leave it. Passwords and extensions come later"}>
                <button type="button" class="btn primary" disabled={isLocked} onClick={async () => setPairing((await act(() => api.startSyncPairing())) ?? null)}>Turn on sync</button>
              </Row>
            </div>
          )}
        </Group>
      </div>
    );
  }

  const summary = s.lastError ?? (s.lastSync ? `Last synced ${relativeTime(s.lastSync).toLowerCase()}` : "Not synced yet");
  return (
    <div class="sec">
      <Group label="Sync" bare>
        <div class="card">
          <Row id="sync-on" title="Sync is on" detail={isLocked ? MANAGED_NOTE : summary}>
            <button type="button" class="btn" disabled={isLocked} onClick={async () => update(await act(() => api.syncNow(), "Synced"))}>Sync now</button>
            <button type="button" class="btn" onClick={() => setConfirmOff(true)}>Turn off</button>
          </Row>
        </div>
        <p class="note">Bookmarks, history and open tabs sync every 15 minutes. Private windows never sync.</p>
      </Group>

      <Group label="Devices" id="sync-devices">
        <div class="card">
          {s.devices.length === 0 && <p class="empty">Perch couldn't list your devices right now.</p>}
          {s.devices.map((d) => (
            <Row key={d.id} title={d.current ? `${d.name} (this Mac)` : d.name} detail={`${KIND[d.kind] ?? d.kind} · seen ${relativeTime(d.lastSeen).toLowerCase()}`}>
              {!d.current && <button type="button" class="btn" aria-label={`Remove ${d.name}`} onClick={() => setRemoving(d)}>Remove</button>}
            </Row>
          ))}
        </div>
      </Group>

      <Dialog
        open={confirmOff}
        title="Turn off sync on this Mac?"
        onClose={() => setConfirmOff(false)}
        footer={(
          <>
            <button type="button" class="btn" onClick={() => setConfirmOff(false)}>Cancel</button>
            <button type="button" class="btn primary" onClick={async () => { setConfirmOff(false); update(await act(() => api.turnOffSync(), "Sync is off")); }}>Turn off sync</button>
          </>
        )}
      >
        <p>This Mac stops syncing and forgets its sync keys. Your bookmarks, history and tabs stay here, and your other devices keep syncing.</p>
      </Dialog>

      <Dialog
        open={removing !== null}
        title={removing ? `Remove ${removing.name}?` : ""}
        onClose={() => setRemoving(null)}
        footer={removing && (
          <>
            <button type="button" class="btn" onClick={() => setRemoving(null)}>Cancel</button>
            <button type="button" class="btn primary" onClick={async () => {
              const d = removing;
              setRemoving(null);
              update(await act(() => api.removeSyncDevice(d.id), `Removed ${d.name}`));
            }}>Remove device</button>
          </>
        )}
      >
        <p>It's signed out of your sync account and stops syncing. Data already on it stays there.</p>
      </Dialog>
    </div>
  );
}
