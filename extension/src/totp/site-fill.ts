/** Where a code may be filled, and the function that fills it inside the page. */

/** A code fills only on its site or that site's subdomains; anywhere else it can only be copied. */
export function siteMatches(site: string | null, host: string): boolean {
  if (!site) return false;
  return host === site || host.endsWith(`.${site}`);
}

/** Runs inside the page through chrome.scripting: types the code into the frame's one-time-code field. */
export function fillOneTimeCode(code: string, expectedHost: string): boolean {
  if (location.hostname !== expectedHost) return false;
  const isField = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement && !el.disabled && !el.readOnly && ["text", "tel", "number", "password", ""].includes(el.type);
  const candidates = [
    document.activeElement,
    document.querySelector('input[autocomplete="one-time-code"]'),
    document.querySelector('input[name*="otp" i], input[name*="totp" i], input[id*="otp" i], input[name*="code" i][inputmode="numeric"]'),
  ];
  const field = candidates.find(isField);
  if (!field) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, code);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
