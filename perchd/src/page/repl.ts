/**
 * The REPL: the model's JavaScript runs on a copy of the page, never on the page itself.
 *
 * The page's HTML is parsed into a document inside a sealed scratch tab: all network requests
 * are blocked there, and DOM writes throw. So REPL code can read and extract freely, but it
 * cannot click, submit, navigate or send anything, and cannot reach frames. The copy carries what
 * has been typed, chosen and ticked, except in secret fields (passwords, card numbers, one-time
 * codes, and fields that were ever shown as passwords), whose value attributes are stripped too.
 * Changing the page goes through the click, type and select tools and their approvals.
 */

import type { CdpConnection } from "../cdp/connection";
import { Tab } from "../browser/tab";
import { IS_SECRET_JS, rememberedSecrets } from "./secrets";

export type ReplResult = { result: unknown; error?: string };

export const NO_NETWORK_MESSAGE =
  "the REPL has no network access: it reads a copy of the page. To read an API, a feed or another page, open its URL with navigate or open_tab (JSON and text pages work too), then read it";
const NETWORK_ERROR = /Failed to fetch|Failed to parse URL|NetworkError|XMLHttpRequest|ERR_BLOCKED|WebSocket/i;

export const READ_ONLY_MESSAGE = "the REPL is read-only; use click, type and select to change the page";

const LOCK_DOWN = `(() => {
  if (window.__perchLocked) return;
  const msg = ${JSON.stringify(READ_ONLY_MESSAGE)};
  window.__perchStrip = Element.prototype.removeAttribute;
  // Puts the live page's field values on the copy; kept before the setters below are blocked.
  const setter = (proto, n) => Object.getOwnPropertyDescriptor(proto, n).set;
  const sets = { input: setter(HTMLInputElement.prototype, 'value'), area: setter(HTMLTextAreaElement.prototype, 'value'), checked: setter(HTMLInputElement.prototype, 'checked'), selected: setter(HTMLOptionElement.prototype, 'selected') };
  window.__perchFill = (el, state) => {
    if ('files' in state) {
      // Empty stand-ins with the attached files' names: the copy never holds their contents.
      const dt = new DataTransfer();
      state.files.forEach((name) => dt.items.add(new File([], name)));
      el.files = dt.files;
    } else if ('checked' in state) sets.checked.call(el, state.checked);
    else if ('selected' in state) [...el.options].forEach((o, i) => sets.selected.call(o, Boolean(state.selected[i])));
    else if ('value' in state) (el.tagName === 'TEXTAREA' ? sets.area : sets.input).call(el, state.value);
  };
  const fail = function () { throw new Error(msg); };
  const block = (proto, names) => names.forEach((n) => { if (proto && n in proto) Object.defineProperty(proto, n, { value: fail, configurable: true, writable: true }); });
  const blockSet = (proto, names) => names.forEach((n) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, n);
    if (d && d.set) Object.defineProperty(proto, n, { get: d.get, set: fail, configurable: true });
  });
  block(HTMLElement.prototype, ['click', 'focus', 'blur']);
  block(EventTarget.prototype, ['dispatchEvent']);
  block(HTMLFormElement.prototype, ['submit', 'requestSubmit', 'reset']);
  block(Node.prototype, ['appendChild', 'insertBefore', 'removeChild', 'replaceChild']);
  block(Element.prototype, ['setAttribute', 'removeAttribute', 'toggleAttribute', 'setAttributeNS', 'insertAdjacentHTML', 'insertAdjacentElement', 'insertAdjacentText', 'append', 'prepend', 'after', 'before', 'replaceWith', 'remove', 'replaceChildren', 'attachShadow']);
  blockSet(Element.prototype, ['innerHTML', 'outerHTML', 'className', 'id']);
  blockSet(Node.prototype, ['textContent', 'nodeValue']);
  blockSet(HTMLElement.prototype, ['innerText', 'outerText', 'hidden']);
  blockSet(HTMLInputElement.prototype, ['value', 'checked', 'type']);
  blockSet(HTMLTextAreaElement.prototype, ['value']);
  blockSet(HTMLSelectElement.prototype, ['value', 'selectedIndex']);
  blockSet(HTMLOptionElement.prototype, ['selected']);
  window.__perchLocked = true;
})()`;

const sandboxes = new WeakMap<CdpConnection, Promise<Tab>>();

/** One sealed scratch tab per browser: no network, DOM writes blocked, hidden from tab lists. */
async function sandbox(conn: CdpConnection): Promise<Tab> {
  let pending = sandboxes.get(conn);
  if (!pending) {
    pending = (async () => {
      const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
      Tab.hidden.add(targetId);
      const tab = await Tab.attach(conn, targetId);
      await tab.send("Network.enable");
      await tab.send("Network.setBlockedURLs", { urls: ["*"] });
      await tab.evaluate(LOCK_DOWN);
      return tab;
    })();
    sandboxes.set(conn, pending);
  }
  const tab = await pending;
  if (!tab.closed) return tab;
  sandboxes.delete(conn);
  return sandbox(conn);
}

/** Field order, identity and state, read from the live page. Secret fields give no state. */
const FIELD_KEY = `(el) => [el.tagName, el.getAttribute('type') || '', el.getAttribute('name') || '', el.id || ''].join('|')`;
const SECRET_NAME = "/pass|card|cvc|cvv|otp|one.?time/i";
const READ_FIELDS = `function (...skip) {
  const isSecret = ${IS_SECRET_JS};
  const key = ${FIELD_KEY};
  return [...this.querySelectorAll('input, textarea, select')].map((el) => {
    if (skip.includes(el) || isSecret(el) || ${SECRET_NAME}.test((el.getAttribute('name') || '') + ' ' + (el.id || ''))) return [key(el), null];
    if (el.tagName === 'SELECT') return [key(el), { selected: [...el.options].map((o) => o.selected) }];
    if (el.type === 'checkbox' || el.type === 'radio') return [key(el), { checked: el.checked }];
    if (el.type === 'file') return [key(el), { files: [...(el.files || [])].map((f) => f.name) }];
    return [key(el), { value: el.value }];
  });
}`;

type FieldState = [string, { value?: string; checked?: boolean; selected?: boolean[]; files?: string[] } | null];

/**
 * What the user and the agent have typed, chosen and ticked: an HTML copy only has the values the
 * page loaded with, so without this a filled form reads as empty. Fields that are or were secret
 * (a password shown as text after "Show password") are left out.
 */
async function liveFields(tab: Tab, rootNodeId: number): Promise<FieldState[]> {
  try {
    const { object } = await tab.send<{ object: { objectId: string } }>("DOM.resolveNode", { nodeId: rootNodeId });
    const secrets: { objectId: string }[] = [];
    for (const key of rememberedSecrets(tab)) {
      if (!key.startsWith("main:")) continue;
      try {
        const r = await tab.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: Number(key.slice(5)) });
        secrets.push({ objectId: r.object.objectId });
      } catch {
        // The field is gone.
      }
    }
    const res = await tab.send<{ result: { value?: FieldState[] } }>("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: READ_FIELDS,
      arguments: secrets,
      returnByValue: true,
    });
    return res.result.value ?? [];
  } catch {
    return [];
  }
}

export async function repl(tab: Tab, code: string): Promise<ReplResult> {
  const { root } = await tab.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
  const { outerHTML } = await tab.send<{ outerHTML: string }>("DOM.getOuterHTML", { nodeId: root.nodeId });
  const fields = await liveFields(tab, root.nodeId);
  const url = await tab.url();
  const scratch = await sandbox(tab.conn);
  const body = /\b(return|await)\b|^\s*(const|let|var|throw|if|for|while)\b/.test(code) ? code : `return (${code}\n);`;
  const expression = `(async () => {
    const isSecret = ${IS_SECRET_JS};
    const document = new DOMParser().parseFromString(${JSON.stringify(outerHTML)}, 'text/html');
    for (const el of document.querySelectorAll('input')) {
      if (isSecret(el) || ${SECRET_NAME}.test((el.getAttribute('name') || '') + ' ' + (el.id || ''))) window.__perchStrip.call(el, 'value');
    }
    const fields = ${JSON.stringify(fields)};
    const key = ${FIELD_KEY};
    // Fields are matched by position and identity; a copy that parsed differently is left as is.
    [...document.querySelectorAll('input, textarea, select')].forEach((el, i) => {
      const live = fields[i];
      if (live && live[1] && live[0] === key(el)) window.__perchFill(el, live[1]);
    });
    const location = new URL(${JSON.stringify(url)});
    return await (async () => { ${body}\n })();
  })()`;
  const res = await scratch.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, timeout: 30_000 },
  );
  if (res.exceptionDetails) {
    const description = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    const first = description.split("\n")[0]!.replace(/^(Uncaught )?(Type)?Error: /, "");
    return { result: undefined, error: NETWORK_ERROR.test(first) ? NO_NETWORK_MESSAGE : first };
  }
  return { result: res.result.value };
}
