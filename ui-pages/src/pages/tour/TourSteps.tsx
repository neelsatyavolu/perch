import type preact from "preact";
import { useEffect, useState } from "preact/hooks";
import type { AgentSetup } from "../../api";
import { useAction, useApi } from "../../ui/frame";
import "./agents.css";

const AGENT_POLL_MS = 3000;
/** What to type in an agent once Perch is in it. */
const AGENT_TRY = "Use Perch to open my GitHub notifications and tell me which ones need me.";

/** The one-click agent setup, then a live check for each agent's first use of Perch. */
export function AgentsStep({ onInstalled, next }: { readonly onInstalled: () => void; readonly next: preact.ComponentChildren }) {
  const api = useApi();
  const act = useAction();
  const [setup, setSetup] = useState<AgentSetup | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const s = await api.getAgentSetup().catch(() => null);
      if (live && s) setSetup(s);
    };
    void poll();
    const timer = setInterval(poll, AGENT_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);

  const found = setup?.agents.filter((a) => a.found) ?? [];
  const installed = found.length > 0 && found.every((a) => a.installed) && Boolean(setup?.command.installed);
  useEffect(() => {
    if (installed) onInstalled();
  }, [installed]);

  const connect = async () => {
    setBusy(true);
    const s = await act(() => api.connectAgents());
    setBusy(false);
    if (s) setSetup(s);
  };

  return (
    <>
      <p class="cap">Adds the <code>perch</code> command, and Perch's skill and MCP server to each agent.</p>
      {setup && (
        <ul class="tr-agents" aria-label="Agents on this Mac">
          {setup.agents.map((a) => (
            <li key={a.id}>
              <span class="ink">{a.name}</span>
              <span class="cap">
                {!a.found ? "Not on this Mac" : a.error ? a.error : a.connected ? "Connected" : a.installed ? "Ready. Restart it, then try it" : "Not set up yet"}
              </span>
              {a.connected && <span class="status ok"><span class="dotc" />Used Perch</span>}
            </li>
          ))}
          <li>
            <span class="ink"><code>perch</code> command</span>
            <span class="cap">{setup.command.installed ? setup.command.path : setup.command.note ?? "Not installed yet"}</span>
          </li>
        </ul>
      )}
      {setup?.command.shellFile && <p class="note">Perch added ~/.local/bin to your PATH in {setup.command.shellFile}. Open a new terminal window to use <code>perch</code>.</p>}
      {installed && <p class="note">Try it: restart your agent and ask “{AGENT_TRY}”</p>}
      <div class="tr-actions">
        <button type="button" class={installed ? "btn" : "btn primary"} disabled={busy || found.length === 0} onClick={connect}>
          {installed ? "Set up again" : found.length === 0 && setup ? "No agents found" : "Connect my agents"}
        </button>
        {next}
      </div>
    </>
  );
}
