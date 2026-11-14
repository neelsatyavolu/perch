/**
 * Logins the person types into an approval card when nothing is saved for a site (no saved
 * password, no 1Password). They go from the card to the sign_in call that asked, are used once
 * to fill the page, and are never kept, logged or shown to the model. One not used within a
 * couple of minutes is dropped.
 */

export type TypedLogin = { readonly username: string; readonly password: string };

const KEEP_MS = 2 * 60_000;
const waiting = new Map<string, { login: TypedLogin; timer: ReturnType<typeof setTimeout> }>();

/** Holds the login for the call `key` (the approval card's loginKey). */
export function rememberTypedLogin(key: string, login: TypedLogin): void {
  forget(key);
  waiting.set(key, { login, timer: setTimeout(() => waiting.delete(key), KEEP_MS) });
}

/** The login typed for `key`, once: it is gone after this. */
export function takeTypedLogin(key: string): TypedLogin | undefined {
  const held = waiting.get(key);
  forget(key);
  return held?.login;
}

function forget(key: string): void {
  const held = waiting.get(key);
  if (held) clearTimeout(held.timer);
  waiting.delete(key);
}
