import { useState } from "preact/hooks";
import type { McpServer } from "../../api";
import { MCP_SOURCES } from "../../lib/labels";
import { redactTarget } from "../../lib/redact";
import { useAction, useAnnounce, useApi, useLoad } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Download, Icon, MoreHorizontal, Plus } from "../../ui/icons";
import { Group, Row } from "../../ui/Row";
import { Switch } from "../../ui/Switch";
import { McpAddDialog } from "./McpAddDialog";
import { McpImportDialog } from "./McpImportDialog";
import { SkillsCard } from "./SkillsCard";

function describe(s: McpServer): string {
  const tools = s.tools === 0 ? "tools load on first run" : `${s.tools} tools${s.readOnlyTools ? `, ${s.readOnlyTools} read only` : ""}`;
  const trust = s.trusted ? "runs without asking" : "asks before changes";
  return `${s.transport} · from ${MCP_SOURCES[s.source]} · ${tools} · ${trust}`;
}

function ServerDialog({ server, onClose, onChange, onRemove }: {
  readonly server: McpServer | null;
  readonly onClose: () => void;
  readonly onChange: (s: McpServer) => void;
  readonly onRemove: (id: string) => void;
}) {
  const api = useApi();
  const act = useAction();
  return (
    <Dialog
      open={server !== null}
      title={server ? server.name : ""}
      onClose={onClose}
      footer={server && (
        <>
          <button type="button" class="btn danger" onClick={async () => { if (await act(() => api.removeMcpServer(server.id).then(() => true), `Removed ${server.name}`)) onRemove(server.id); }}>
            Remove server
          </button>
          <span class="grow" />
          <button type="button" class="btn primary" onClick={onClose}>Done</button>
        </>
      )}
    >
      {server && (
        <>
          <dl class="kv">
            <dt>Runs</dt><dd class="mono">{redactTarget(server.target).target}</dd>
            <dt>From</dt><dd>{MCP_SOURCES[server.source]}</dd>
            <dt>In the Keychain</dt><dd class="mono">{server.secretNames.length ? server.secretNames.join(", ") : "Nothing"}</dd>
          </dl>
          <div class="card">
            <Row id="mcp-trust" title="Run its tools without asking" detail="Tools marked read only always run freely. Turn this on only for servers you wrote or know well.">
              <Switch label="Run its tools without asking" describedBy="mcp-trust-d" checked={server.trusted} onChange={async (trusted) => {
                const next = await act(() => api.updateMcpServer(server.id, { trusted }));
                if (next) onChange(next);
              }} />
            </Row>
          </div>
        </>
      )}
    </Dialog>
  );
}

export function SkillsMcp() {
  const api = useApi();
  const act = useAction();
  const announce = useAnnounce();
  const servers = useLoad((a) => a.listMcpServers());
  const [dialog, setDialog] = useState<"import" | "add" | null>(null);
  const [selected, setSelected] = useState<McpServer | null>(null);
  const list = servers.data ?? [];
  const replace = (s: McpServer) => servers.set(list.map((x) => (x.id === s.id ? s : x)));

  return (
    <div class="sec">
      <Group label="MCP servers" id="mcp-servers">
        <div class="card">
          {servers.error && <p class="empty">{servers.error}</p>}
          {servers.data && list.length === 0 && <p class="empty">No MCP servers yet. Import the ones you use in other apps, or add one.</p>}
          {list.map((s) => (
            <Row key={s.id} title={s.name} detail={describe(s)} icon={<span class="tile" aria-hidden="true">{s.name.charAt(0)}</span>}>
              <button type="button" class="ib" aria-label={`${s.name} options`} onClick={() => setSelected(s)}><Icon of={MoreHorizontal} /></button>
              <Switch label={`Use ${s.name}`} checked={s.enabled} onChange={async (enabled) => {
                const next = await act(() => api.updateMcpServer(s.id, { enabled }));
                if (next) replace(next);
              }} />
            </Row>
          ))}
          <div id="mcp-import">
            <button type="button" class="more-row" onClick={() => setDialog("import")}>
              <Icon of={Download} />Import from Claude Code, Codex, Claude Desktop, Cursor and Grok
            </button>
          </div>
          <button type="button" class="more-row" onClick={() => setDialog("add")}><Icon of={Plus} />Add a server</button>
        </div>
        <p class="note">Secrets from imported servers are moved into the Keychain. You can turn any server off for a single chat from the composer.</p>
      </Group>
      <SkillsCard />
      <McpImportDialog
        open={dialog === "import"}
        onClose={() => setDialog(null)}
        onImported={(added) => {
          setDialog(null);
          servers.set([...list, ...added]);
          announce(added.length === 1 ? "Imported 1 server" : `Imported ${added.length} servers`);
        }}
      />
      <McpAddDialog
        open={dialog === "add"}
        onClose={() => setDialog(null)}
        onAdded={(s) => {
          setDialog(null);
          servers.set([...list, s]);
          announce(`Added ${s.name}`);
        }}
      />
      <ServerDialog
        server={selected}
        onClose={() => setSelected(null)}
        onChange={(s) => {
          replace(s);
          setSelected(s);
        }}
        onRemove={(id) => {
          setSelected(null);
          servers.set(list.filter((x) => x.id !== id));
        }}
      />
    </div>
  );
}
