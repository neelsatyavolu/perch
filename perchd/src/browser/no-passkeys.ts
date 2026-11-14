/**
 * Passkeys in the agent's own tabs. A site like Amazon asks for a passkey as its sign-in page
 * opens, and Chromium answers with a window of its own (Touch ID, a phone's QR code) that the
 * agent can neither see nor close, so the task stalls. In tabs the agent opened, a passkey request
 * is turned down at once, as if the person pressed Cancel, and the site offers its password form,
 * which sign_in fills. The person's own tabs are never changed.
 */

import type { Tab } from "./tab";

/** Runs in every frame before the page's own scripts. Other credentials (passwords) pass through. */
export const NO_PASSKEYS_JS = `(() => {
  const c = navigator.credentials;
  if (!c || c.__perchNoPasskeys) return;
  Object.defineProperty(c, "__perchNoPasskeys", { value: true });
  const cancel = () => Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
  const get = c.get.bind(c);
  const create = c.create.bind(c);
  c.get = (options) => (options && options.publicKey ? cancel() : get(options));
  c.create = (options) => (options && options.publicKey ? cancel() : create(options));
  const pk = window.PublicKeyCredential;
  if (pk) {
    pk.isConditionalMediationAvailable = () => Promise.resolve(false);
    pk.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
  }
})();`;

/** For pages the tab loads from now on, and the one it shows now. */
export async function withoutPasskeys(tab: Tab): Promise<void> {
  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: NO_PASSKEYS_JS }).catch(() => undefined);
  await tab.send("Runtime.evaluate", { expression: NO_PASSKEYS_JS }).catch(() => undefined);
}
