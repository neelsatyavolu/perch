import { useState } from "preact/hooks";
import type { Provider } from "../api";
import { useAction, useApi } from "./frame";

/** The code a provider's sign-in page shows after approving (Claude), pasted back to finish signing in. */
export function PasteCode({ provider, onDone, onCancel }: { readonly provider: Provider; readonly onDone: (p: Provider) => void; readonly onCancel: () => void }) {
  const api = useApi();
  const act = useAction();
  const [code, setCode] = useState("");
  return (
    <form
      class="paste-code"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act(() => api.finishSignIn(provider.id, code.trim()), `Signed in to ${provider.name}`);
        if (r) onDone(r);
      }}
    >
      <label for={`code-${provider.id}`}>Paste the code {provider.name} shows after you approve</label>
      <input id={`code-${provider.id}`} class="field mono" autoFocus spellcheck={false} autoComplete="off" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
      <button type="submit" class="btn primary" disabled={!code.trim()}>Finish signing in</button>
      <button type="button" class="btn" onClick={onCancel}>Cancel</button>
    </form>
  );
}
