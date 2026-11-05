/** Which form fields hold secrets the model must never see. */

export const REDACTED = "••••";

const SECRET_AUTOCOMPLETE = /^(cc-.+|one-time-code|current-password|new-password)$/;

export function isSecretField(attrs: Record<string, string | undefined>): boolean {
  if ((attrs.type ?? "").toLowerCase() === "password") return true;
  const tokens = (attrs.autocomplete ?? "").toLowerCase().split(/\s+/);
  return tokens.some((token) => SECRET_AUTOCOMPLETE.test(token));
}
