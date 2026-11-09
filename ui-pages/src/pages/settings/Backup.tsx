/**
 * Recovery and backup (spec 11.1, plan 3b task 3): export an encrypted copy of everything Perch
 * keeps, and restore this profile's key from the recovery key. The browser does the work; the
 * Welcome page reuses RestoreForm when this Mac has Perch data but not its key.
 */

import { useState } from "preact/hooks";
import { errorText, useApi, useLoad } from "../../ui/frame";
import { Group, Row } from "../../ui/Row";
import { RecoveryKey } from "./Sync";
import "./backup.css";

const NO_HELPER = "This build of Perch has no key helper";

const RESTORE_ERRORS: Readonly<Record<string, string>> = {
  "wrong-key": "That recovery key doesn't match this Perch data. Check it and try again.",
  "bad-backup": "That file isn't a Perch backup, or it's damaged.",
  unavailable: `${NO_HELPER}.`,
  failed: "Perch couldn't restore your data. Try again.",
  busy: "Perch is already backing up or restoring. Try again when it's done.",
};

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

type Result = { readonly ok: boolean; readonly text: string };

function Message({ result }: { readonly result: Result | null }) {
  if (!result) return null;
  return result.ok
    ? <p class="note" role="status">{result.text}</p>
    : <p class="field-error" role="alert">{result.text}</p>;
}

/** The recovery key form: 52 characters in groups of five, any case, dashes and spaces optional. */
export function RestoreForm({ disabled = false, onRestored }: { readonly disabled?: boolean; readonly onRestored?: () => void }) {
  const api = useApi();
  const [key, setKey] = useState("");
  const [fromBackup, setFromBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const submit = async (replaceData = false) => {
    setBusy(true);
    setResult(null);
    setConfirmReplace(false);
    try {
      const { restored } = await api.restoreFromRecoveryKey({ recoveryKey: key.trim(), fromBackup, replaceData });
      if (restored) {
        setKey("");
        setResult({ ok: true, text: "Restored. Perch reloaded your data." });
        onRestored?.();
      }
    } catch (e) {
      if (codeOf(e) === "replaces-data") setConfirmReplace(true);
      else setResult({ ok: false, text: RESTORE_ERRORS[codeOf(e) ?? ""] ?? errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="restore-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        class="field mono restore-key"
        aria-label="Recovery key"
        rows={2}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX"
        spellcheck={false}
        autocomplete="off"
        autocapitalize="characters"
        value={key}
        disabled={disabled}
        aria-invalid={result && !result.ok ? "true" : undefined}
        onInput={(e) => setKey((e.currentTarget as HTMLTextAreaElement).value)}
      />
      <label class="check">
        <input type="checkbox" checked={fromBackup} disabled={disabled} onChange={(e) => setFromBackup((e.currentTarget as HTMLInputElement).checked)} />
        Also restore from a backup file
      </label>
      <div>
        <button type="submit" class="btn primary" disabled={disabled || busy || key.trim() === ""}>Restore</button>
      </div>
      {confirmReplace && (
        <div class="restore-confirm" role="alert">
          <p>This backup was made with a different key than the Perch data on this Mac. Restoring it moves that data aside, and only its own recovery key opens it.</p>
          <div>
            <button type="button" class="btn" onClick={() => setConfirmReplace(false)}>Cancel</button>
            <button type="button" class="btn primary" onClick={() => submit(true)}>Replace and restore</button>
          </div>
        </div>
      )}
      <Message result={result} />
    </form>
  );
}

/** Settings › Privacy and security › Backup and restore. */
export function BackupGroup() {
  const api = useApi();
  const security = useLoad((a) => a.getSecurity());
  const [exported, setExported] = useState<Result | null>(null);
  const [restoring, setRestoring] = useState(false);
  const s = security.data;
  if (!s) return security.error ? <p class="mute">{security.error}</p> : null;
  const off = !s.available;

  const exportAll = async () => {
    setExported(null);
    try {
      const r = await api.exportBackup();
      if (r.saved) setExported({ ok: true, text: r.name ? `Saved ${r.name}` : "Saved" });
    } catch (e) {
      setExported({ ok: false, text: codeOf(e) === "unavailable" ? `${NO_HELPER}.` : errorText(e) });
    }
  };

  return (
    <>
    <RecoveryKey />
    <Group label="Backup and restore" id="backup">
      {s.available && !s.protected && <p class="note" role="note">Keys are not protected by the Secure Enclave in this build</p>}
      <div class="card">
        <Row id="backup-export" title="Export everything" detail={off ? NO_HELPER : "An encrypted file with your chats, memory, skills, routines and agent settings. Your recovery key opens it"}>
          <button type="button" class="btn" disabled={off} onClick={exportAll}>Export</button>
        </Row>
        {exported && <div class="backup-msg"><Message result={exported} /></div>}
        <Row id="backup-restore" title="Restore from recovery key" detail={off ? NO_HELPER : "Unlocks Perch data on this Mac, for example after moving to a new Mac"}>
          <button type="button" class="btn" disabled={off} aria-expanded={restoring} onClick={() => setRestoring(!restoring)}>{restoring ? "Cancel" : "Restore"}</button>
        </Row>
        {restoring && !off && <RestoreForm />}
      </div>
    </Group>
    </>
  );
}
