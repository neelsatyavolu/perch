import { useEffect, useState } from "preact/hooks";
import type { McpImportCandidate, McpServer } from "../../api";
import { MCP_SOURCES } from "../../lib/labels";
import { errorText, useApi } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";

type Props = { readonly open: boolean; readonly onClose: () => void; readonly onImported: (added: readonly McpServer[]) => void };

/**
 * Lists the MCP servers already set up in Claude Code, Codex, Claude Desktop, Cursor and Grok
 * (spec 7.5). Each shows where it was found, how it runs and which secrets move to the Keychain.
 * Nothing is imported until the person picks servers and confirms.
 */
export function McpImportDialog({ open, onClose, onImported }: Props) {
  const api = useApi();
  const [found, setFound] = useState<readonly McpImportCandidate[] | null>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFound(null);
    setError(null);
    api.scanMcpImports().then(
      (c) => {
        setFound(c);
        setPicked(c.filter((x) => !x.alreadyAdded).map((x) => x.key));
      },
      (e) => setError(errorText(e)),
    );
  }, [open]);

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const run = async () => {
    setBusy(true);
    try {
      onImported(await api.importMcpServers(picked));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const sources = [...new Set((found ?? []).map((c) => c.source))];
  const count = picked.length;

  return (
    <Dialog
      open={open}
      wide
      title="Import MCP servers"
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>Cancel</button>
          <button type="button" class="btn primary" disabled={busy || count === 0} onClick={run}>
            {count === 1 ? "Import 1 server" : `Import ${count} servers`}
          </button>
        </>
      }
    >
      <p class="note">
        Secrets in a server's settings move into the macOS Keychain and are not kept in files. Imported servers run as you, and each asks before its first run.
      </p>
      {error && <p class="field-error" role="alert">{error}</p>}
      {!found && !error && <p class="mute" aria-busy="true">Looking in Claude Code, Codex, Claude Desktop, Cursor and Grok</p>}
      {found && found.length === 0 && <p class="mute">No MCP servers found in Claude Code, Codex, Claude Desktop, Cursor or Grok.</p>}
      {sources.map((src) => (
        <fieldset key={src} class="cand-group">
          <legend class="cand-src">{MCP_SOURCES[src]}</legend>
          {found!.filter((c) => c.source === src).map((c) => (
            <label key={c.key} class="cand">
              <input
                type="checkbox"
                class="check-input"
                checked={c.alreadyAdded || picked.includes(c.key)}
                disabled={c.alreadyAdded}
                onChange={() => toggle(c.key)}
                aria-describedby={`cand-${c.key.replace(/\W/g, "-")}`}
              />
              <span class="meta">
                <span class="ink">{c.name}{c.alreadyAdded && <span class="mute"> · already added</span>}</span>
                <span class="mono" id={`cand-${c.key.replace(/\W/g, "-")}`}>
                  {c.transport} · {c.target} · from {c.configPath}
                  {c.secretNames.length > 0 && ` · to Keychain: ${c.secretNames.join(", ")}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
    </Dialog>
  );
}
