import { useState } from "preact/hooks";
import type { Provider } from "../api";
import { useAction, useApi } from "./frame";

/**
 * Sign in to a plan. The provider's page opens in a new tab; Perch finishes the sign-in itself when
 * the person approves there (Claude's code is read off the tab), so the button only says it's
 * waiting. `onCode`: an older Perch that still needs the code pasted.
 */
export function SignInButton({ provider, onDone, onCode }: {
  readonly provider: Provider;
  readonly onDone: (p: Provider) => void;
  readonly onCode: () => void;
}) {
  const api = useApi();
  const act = useAction();
  const [waiting, setWaiting] = useState(false);
  return (
    <span class="signin">
      {waiting && <span class="cap" role="status">Approve Perch in the tab that opened</span>}
      <button type="button" class="btn" aria-label={`Sign in to ${provider.name}`} disabled={waiting} onClick={async () => {
        setWaiting(true);
        const r = await act(() => api.signIn(provider.id), "");
        setWaiting(false);
        if (!r) return;
        if (r.awaitingCode) onCode();
        else onDone(r);
      }}>{waiting ? "Waiting…" : "Sign in"}</button>
    </span>
  );
}
