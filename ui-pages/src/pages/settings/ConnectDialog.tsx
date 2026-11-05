import { useState } from "preact/hooks";
import type { ConnectInput, Provider } from "../../api";
import { checkApiKey, checkEndpointUrl, checkTitle } from "../../lib/validate";
import { errorText, useApi } from "../../ui/frame";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";

type Props = { readonly provider: Provider | null; readonly onClose: () => void; readonly onDone: (p: Provider) => void };

/**
 * Adds an API key or a local endpoint. The key field is a password field, the value goes straight
 * to perchd (which keeps it in the Keychain), and the dialog forgets it when it closes.
 */
export function ConnectDialog({ provider, onClose, onDone }: Props) {
  const api = useApi();
  const [key, setKey] = useState("");
  const [name, setName] = useState("Ollama");
  const [url, setUrl] = useState("http://localhost:11434/v1");
  const [error, setError] = useState<{ field: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const local = provider?.kind === "local";

  const close = () => {
    setKey("");
    setError(null);
    onClose();
  };

  const save = async () => {
    if (!provider) return;
    let input: ConnectInput;
    if (local) {
      const n = checkTitle(name, 60);
      if (!n.ok) return setError({ field: "name", text: n.error });
      const u = checkEndpointUrl(url);
      if (!u.ok) return setError({ field: "url", text: u.error });
      const k = key.trim() ? checkApiKey(key) : null;
      if (k && !k.ok) return setError({ field: "key", text: k.error });
      input = { kind: "endpoint", name: n.value, baseUrl: u.value, key: k?.ok ? k.value : undefined };
    } else {
      const k = checkApiKey(key);
      if (!k.ok) return setError({ field: "key", text: k.error });
      input = { kind: "api-key", provider: provider.id as Extract<ConnectInput, { kind: "api-key" }>["provider"], key: k.value };
    }
    setBusy(true);
    try {
      const p = await api.connectProvider(input);
      setKey("");
      setError(null);
      onDone(p);
    } catch (e) {
      setError({ field: "key", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const errorFor = (id: string) => (error?.field === id ? error.text : null);

  return (
    <Dialog
      open={provider !== null}
      title={local ? "Connect a model on this Mac" : `Add your ${provider?.name ?? ""} key`}
      onClose={close}
      footer={
        <>
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="button" class="btn primary" disabled={busy} onClick={save}>{local ? "Connect" : "Save key"}</button>
        </>
      }
    >
      <form
        class="dlg-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {local && (
          <>
            <Field label="Name" error={errorFor("name")}>
              {(a) => <input class="field" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} {...a} />}
            </Field>
            <Field label="Address" hint="Any OpenAI-compatible endpoint, such as Ollama or LM Studio" error={errorFor("url")}>
              {(a) => <input class="field mono" value={url} spellcheck={false} onInput={(e) => setUrl((e.currentTarget as HTMLInputElement).value)} {...a} />}
            </Field>
          </>
        )}
        <Field label={local ? "API key, if it needs one" : "API key"} hint="Saved in the macOS Keychain. Perch never shows it again." error={errorFor("key")}>
          {(a) => (
            <input class="field mono" type="password" autoComplete="off" spellcheck={false} value={key} onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} {...a} />
          )}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
