/** Live DOM nodes behind refs, and calling functions on them. Shared by the page actions. */

import type { Tab } from "../browser/tab";
import { RefGone, type RefTable, type RefTarget } from "./refs";

/** A live node: its ids, its session (for cross-site iframes) and the iframe that owns it. */
export type Node = RefTarget & { objectId: string };

/** The live DOM object behind a ref, or RefGone if the page removed it. */
export async function liveNode(tab: Tab, refs: RefTable, ref: string): Promise<Node> {
  const target = refs.resolve(ref);
  let objectId: string | undefined;
  try {
    ({ object: { objectId } } = await tab.sendIn<{ object: { objectId?: string } }>(target.session, "DOM.resolveNode", { backendNodeId: target.backendNodeId }));
  } catch {
    throw new RefGone(ref);
  }
  if (!objectId) throw new RefGone(ref);
  const node: Node = { ...target, objectId };
  const connected = await call<boolean>(tab, node, "function () { return this.isConnected; }");
  if (!connected) throw new RefGone(ref);
  return node;
}

export async function call<T>(tab: Tab, node: { objectId: string; session?: string }, fn: string, args: unknown[] = []): Promise<T> {
  const res = await tab.sendIn<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
    node.session,
    "Runtime.callFunctionOn",
    { objectId: node.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
  );
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value as T;
}

/** Like call, but returns the result as a live object id (undefined for null or undefined). */
export async function callForObject(tab: Tab, node: { objectId: string; session?: string }, fn: string, args: unknown[] = []): Promise<string | undefined> {
  const res = await tab.sendIn<{ result: { objectId?: string; subtype?: string } }>(node.session, "Runtime.callFunctionOn", {
    objectId: node.objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: false,
  });
  return res.result.subtype === "null" ? undefined : res.result.objectId;
}

/**
 * Role and name of an element, for notes, approvals and "covered by" errors. Field values are
 * never used as names (they may be secrets), except the label of an input button.
 */
export const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const owner = (el && el.closest('[role],dialog,button,a,input,select,textarea,label,h1,h2,h3')) || el;
  if (!owner) return { role: 'element', name: '' };
  const tag = owner.tagName;
  const type = (owner.getAttribute('type') || '').toLowerCase();
  const role = owner.getAttribute('role') || ({ A: 'link', DIALOG: 'dialog', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', BUTTON: 'button', LABEL: 'label' })[tag]
    || (tag === 'INPUT' ? (['button', 'submit', 'reset'].includes(type) ? 'button' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'search' ? 'searchbox' : 'textbox') : tag.toLowerCase());
  const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const label = owner.getAttribute('aria-label') || (owner.labels && owner.labels[0] && owner.labels[0].innerText) || owner.getAttribute('placeholder') || owner.getAttribute('title') || '';
  const text = isField ? (['button', 'submit', 'reset'].includes(type) ? owner.value : '') : owner.innerText;
  return { role, name: (label || text || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
}`;

export type Described = { role: string; name: string };
export const show = (d: Described) => (d.name ? `${d.role} "${d.name}"` : d.role);

export async function describe(tab: Tab, node: { objectId: string; session?: string }): Promise<string> {
  return show(await call<Described>(tab, node, DESCRIBE));
}
