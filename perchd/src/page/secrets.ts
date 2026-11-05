/** Which form fields hold secrets the model must never see. */

export const REDACTED = "••••";

const SECRET_AUTOCOMPLETE = /^(cc-.+|one-time-code|current-password|new-password)$/;

export function isSecretField(attrs: Record<string, string | undefined>): boolean {
  if ((attrs.type ?? "").toLowerCase() === "password") return true;
  const tokens = (attrs.autocomplete ?? "").toLowerCase().split(/\s+/);
  return tokens.some((token) => SECRET_AUTOCOMPLETE.test(token));
}

/** The same rule as isSecretField, as a function source for code that runs inside the page. */
export const IS_SECRET_JS = `(el) => {
  if (!el || el.tagName !== 'INPUT') return false;
  if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
  return (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/)
    .some((t) => /^(cc-.+|one-time-code|current-password|new-password)$/.test(t));
}`;
