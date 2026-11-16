/**
 * What Enter would act on in a field, read from the page, so Guard can tell a search or a time
 * field from a message box or a sign-up form (permissions.ts, enterKind).
 */

import type { ToolCall } from "../models/types";
import { call as callOn, liveNode } from "../page/node";
import { refsFor } from "../page/refs";
import type { EnterField } from "./permissions";
import type { ToolContext } from "./tools";

const REF = /^e\d{1,7}$/;

/**
 * Runs with `this` as the field. The button Enter presses is the field itself when it is a button,
 * otherwise the form's first submit button, including one outside the form tied to it by form=.
 */
const FIELD_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const type = (el.getAttribute('type') || '').toLowerCase();
  const words = [el.getAttribute('placeholder'), el.getAttribute('name'), el.id, el.getAttribute('autocomplete')].filter(Boolean).join(' ').slice(0, 200);
  const multiline = el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('aria-multiline') === 'true';
  const form = el.form || el.closest('form');
  const action = form ? form.getAttribute('action') || '' : '';
  const search = type === 'search' || Boolean(el.closest('[role=search]')) || /\\bsearch/i.test(action);
  const own = el.matches('button, input[type=submit], input[type=image], input[type=button], input[type=reset]');
  const button = own ? el : form && Array.from(form.elements || []).find((b) => b.type === 'submit' || b.type === 'image');
  const label = button ? button.getAttribute('aria-label') || button.innerText || button.value || button.getAttribute('alt') || button.title || '' : '';
  const post = Boolean(form) && (form.getAttribute('method') || '').toLowerCase() === 'post';
  return { words, multiline, search, submit: label.replace(/\\s+/g, ' ').trim().slice(0, 80), post };
}`;

const isEnter = (call: ToolCall) => /(^|\+)enter$/i.test(String(call.args.key ?? ""));

/** The field an Enter acts in (a press at the focus, or a type with submit), or undefined. */
export async function enterField(ctx: ToolContext, call: ToolCall): Promise<EnterField | undefined> {
  const tab = ctx.tab;
  if (!tab) return undefined;
  try {
    if (call.name === "press" && isEnter(call)) {
      return (await tab.evaluate<EnterField | null>(`(${FIELD_FN}).call(document.activeElement || document.body)`)) ?? undefined;
    }
    if (call.name === "type" && call.args.submit && typeof call.args.ref === "string" && REF.test(call.args.ref)) {
      return (await callOn<EnterField | null>(tab, await liveNode(tab, refsFor(tab), call.args.ref), FIELD_FN)) ?? undefined;
    }
  } catch {
    // An unreadable field is judged by its role and name alone.
  }
  return undefined;
}
