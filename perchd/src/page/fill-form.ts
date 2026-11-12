/**
 * Fills a login or a one-time code that perchd holds (from 1Password) into the tab's main frame,
 * the way a password manager does. Three steps keep the values safe from the page and the model:
 *
 *   1. find the fields, with no secret in the page yet;
 *   2. hand their backend node ids to the caller, which hides them from every later snapshot,
 *      before any value is written (so a page can't dodge the masking);
 *   3. write each value only if the page is still on the origin the login was picked for, checked
 *      inside the page at the moment of writing (a navigation during Touch ID fills nothing).
 *
 * Values go in as call arguments over CDP, never into a snapshot or a tool result.
 */

import type { FillOutcome } from "../browser/perch-domain";
import type { Tab } from "../browser/tab";

export type FormFill = { readonly result: FillOutcome; readonly fields: readonly number[] };

/** Runs in the page with no secrets: the username and password inputs, either possibly null. */
const FIND_LOGIN_JS = `function () {
  const usable = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly;
  };
  const type = (el) => (el.getAttribute('type') || 'text').toLowerCase();
  const textLike = (el) => ['text', 'email', 'tel'].includes(type(el));
  const auto = (el) => (el.getAttribute('autocomplete') || '').toLowerCase();
  const named = (el) => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder].join(' ');
  const all = [...document.querySelectorAll('input')].filter(usable);
  const pw = all.find((el) => type(el) === 'password' && !auto(el).includes('new-password')) || all.find((el) => type(el) === 'password') || null;
  const scope = pw && pw.form ? [...pw.form.querySelectorAll('input')].filter(usable) : all;
  let user = scope.find((el) => textLike(el) && /username|email/.test(auto(el)));
  if (!user && pw) user = scope.filter((el) => textLike(el) && (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)).pop();
  if (!user && !pw) user = scope.find((el) => textLike(el) && /user|e-?mail|login|account|identifier/i.test(named(el)));
  return [user && !user.value ? user : null, pw];
}`;

/** Runs in the page with no secrets: one code box, or a row of one-digit boxes. */
const FIND_CODE_JS = `function (length) {
  const usable = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly && getComputedStyle(el).visibility !== 'hidden';
  };
  const all = [...document.querySelectorAll('input')].filter(usable).filter((el) => !['hidden', 'password', 'checkbox', 'radio', 'submit', 'button'].includes((el.getAttribute('type') || 'text').toLowerCase()));
  const digits = all.filter((el) => el.maxLength === 1);
  if (digits.length >= length) return digits.slice(0, length);
  const named = (el) => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder].join(' ');
  const box = all.find((el) => (el.getAttribute('autocomplete') || '').includes('one-time-code'))
    || all.find((el) => /otp|totp|2fa|mfa|one.?time|verification|security.?code|auth.?code|\\bcode\\b/i.test(named(el)));
  return box ? [box] : [];
}`;

/** Runs on one input: writes the value only while the page is still on the expected origin. */
const PUT_JS = `function (value, origin) {
  if (location.origin !== origin || !this.isConnected) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  this.focus();
  setter.call(this, value);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

type RemoteObject = { objectId?: string };

/** The inputs a finder returned, in order, as remote objects (null where it found none). */
async function findInputs(tab: Tab, finder: string, args: readonly unknown[]): Promise<(string | null)[]> {
  const doc = await tab.send<{ result: RemoteObject }>("Runtime.evaluate", { expression: "document" });
  if (!doc.result.objectId) return [];
  const found = await tab.send<{ result: RemoteObject; exceptionDetails?: unknown }>("Runtime.callFunctionOn", {
    objectId: doc.result.objectId,
    functionDeclaration: finder,
    arguments: args.map((value) => ({ value })),
  });
  if (found.exceptionDetails || !found.result.objectId) return [];
  const { result } = await tab.send<{ result: { name: string; value?: RemoteObject & { subtype?: string } }[] }>("Runtime.getProperties", { objectId: found.result.objectId, ownProperties: true });
  return result
    .filter((p) => /^\d+$/.test(p.name))
    .sort((a, b) => Number(a.name) - Number(b.name))
    .map((p) => (p.value?.subtype === "node" && p.value.objectId ? p.value.objectId : null));
}

async function backendId(tab: Tab, objectId: string): Promise<number | null> {
  const { node } = await tab.send<{ node: { backendNodeId?: number } }>("DOM.describeNode", { objectId });
  return Number.isInteger(node.backendNodeId) ? node.backendNodeId! : null;
}

async function put(tab: Tab, objectId: string, value: string, origin: string): Promise<boolean> {
  const r = await tab.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: PUT_JS,
    arguments: [{ value }, { value: origin }],
    returnByValue: true,
  });
  return !r.exceptionDetails && r.result?.value === true;
}

/**
 * Finds the targets, reports their node ids through `hide` before any value goes in, then writes
 * value i into target i (skipping empty values and missing targets).
 */
async function fill(tab: Tab, finder: string, args: readonly unknown[], valuesFor: (targets: number) => readonly string[], origin: string, hide: (fields: readonly number[]) => void): Promise<FormFill> {
  try {
    const targets = await findInputs(tab, finder, args);
    const values = valuesFor(targets.length);
    const pairs = targets.flatMap((objectId, i) => (objectId && values[i] ? [{ objectId, value: values[i]! }] : []));
    if (pairs.length === 0) return { result: "no-form", fields: [] };
    const fields = (await Promise.all(pairs.map((p) => backendId(tab, p.objectId)))).filter((n): n is number => n !== null);
    hide(fields);
    let wrote = 0;
    for (const p of pairs) if (await put(tab, p.objectId, p.value, origin)) wrote++;
    return { result: wrote === pairs.length ? "filled" : wrote ? "needs-user" : "failed", fields };
  } catch {
    return { result: "failed", fields: [] };
  }
}

export function fillLoginFields(tab: Tab, origin: string, username: string, password: string, hide: (fields: readonly number[]) => void): Promise<FormFill> {
  return fill(tab, FIND_LOGIN_JS, [], () => [username, password], origin, hide);
}

export function fillCodeField(tab: Tab, origin: string, code: string, hide: (fields: readonly number[]) => void): Promise<FormFill> {
  // A row of one-digit boxes takes a digit each; a single box takes the whole code.
  return fill(tab, FIND_CODE_JS, [code.length], (targets) => (targets > 1 ? [...code] : [code]), origin, hide);
}
