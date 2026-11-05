import { useState } from "preact/hooks";
import type { McpServer, McpTransport } from "../../api";
import { checkCommand, checkMcpUrl, checkSecretName, checkTitle } from "../../lib/validate";
import { errorText, useApi } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Icon, Plus, X } from "../../ui/icons";
import { Segmented } from "../../ui/Segmented";

type Secret = { readonly name: string; readonly value: string };
type Props = { readonly open: boolean; readonly onClose: () => void; readonly onAdded: (s: McpServer) => void };

/** Adds an MCP server by hand. Secret values are write-only: they go to the Keychain through perchd. */
export function McpAddDialog({ open, onClose, onAdded }: Props) {
  const api = useApi();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [target, setTarget] = useState("");
  const [secrets, setSecrets] = useState<readonly Secret[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setTarget("");
    setSecrets([]);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const editSecret = (i: number, patch: Partial<Secret>) => setSecrets((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = async () => {
    const n = checkTitle(name, 60);
    if (!n.ok) return setError(n.error);
    const t = transport === "stdio" ? checkCommand(target) : checkMcpUrl(target);
    if (!t.ok) return setError(t.error);
    for (const s of secrets) {
      const c = checkSecretName(s.name);
      if (!c.ok) return setError(c.error);
      if (!s.value) return setError(`Enter a value for ${s.name}`);
    }
    try {
      const added = await api.addMcpServer({ name: n.value, transport, target: t.value, secrets });
      reset();
      onAdded(added);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const secretWord = transport === "stdio" ? "Environment variables" : "Headers";
  return (
    <Dialog
      open={open}
      title="Add an MCP server"
      onClose={close}
      footer={
        <>
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="button" class="btn primary" onClick={save}>Add server</button>
        </>
      }
    >
      <label class="label">
        <span>Name</span>
        <input class="field" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <div class="label">
        <span id="mcp-transport">How it runs</span>
        <Segmented<McpTransport> label="How it runs" value={transport} onChange={setTransport} options={[
          { value: "stdio", label: "Command" }, { value: "http", label: "HTTP" }, { value: "sse", label: "SSE" },
        ]} />
      </div>
      <label class="label">
        <span>{transport === "stdio" ? "Command" : "Address"}</span>
        <input
          class="field mono"
          spellcheck={false}
          placeholder={transport === "stdio" ? "npx -y @modelcontextprotocol/server-filesystem ~/Documents" : "https://"}
          value={target}
          onInput={(e) => setTarget((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <div class="label">
        <span>{secretWord}</span>
        {secrets.map((s, i) => (
          <div key={i} class="secret-row">
            <input class="field mono" aria-label={`Name ${i + 1}`} placeholder="NAME" value={s.name} onInput={(e) => editSecret(i, { name: (e.currentTarget as HTMLInputElement).value })} />
            <input class="field mono" type="password" autoComplete="off" aria-label={`Value ${i + 1}`} placeholder="Value" value={s.value} onInput={(e) => editSecret(i, { value: (e.currentTarget as HTMLInputElement).value })} />
            <button type="button" class="ib" aria-label={`Remove ${s.name || `entry ${i + 1}`}`} onClick={() => setSecrets((x) => x.filter((_, j) => j !== i))}><Icon of={X} /></button>
          </div>
        ))}
        <button type="button" class="btn quiet" style={{ justifySelf: "start" }} onClick={() => setSecrets((s) => [...s, { name: "", value: "" }])}>
          <Icon of={Plus} />Add {transport === "stdio" ? "a variable" : "a header"}
        </button>
        <span>Values are saved in the macOS Keychain, not in a file.</span>
      </div>
      {error && <p class="field-error" role="alert">{error}</p>}
    </Dialog>
  );
}
