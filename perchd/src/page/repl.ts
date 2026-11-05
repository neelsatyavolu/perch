/**
 * The REPL: the model's JavaScript runs on a copy of the page, never on the page itself.
 *
 * The page's HTML is parsed into a document inside a sealed scratch tab: all network requests
 * are blocked there, and DOM writes throw. So REPL code can read and extract freely, but it
 * cannot click, submit, navigate or send anything, cannot reach frames, and never sees typed
 * secrets (a copy of the HTML holds no typed values; secret value attributes are stripped too).
 * Changing the page goes through the click, type and select tools and their approvals.
 */

import type { CdpConnection } from "../cdp/connection";
import { Tab } from "../browser/tab";
import { IS_SECRET_JS } from "./secrets";

export type ReplResult = { result: unknown; error?: string };

export const NO_NETWORK_MESSAGE =
  "the REPL has no network access: it reads a copy of the page. To read an API, a feed or another page, open its URL with navigate or open_tab (JSON and text pages work too), then read it";
const NETWORK_ERROR = /Failed to fetch|Failed to parse URL|NetworkError|XMLHttpRequest|ERR_BLOCKED|WebSocket/i;

export const READ_ONLY_MESSAGE = "the REPL is read-only; use click, type and select to change the page";

const LOCK_DOWN = `(() => {
  if (window.__perchLocked) return;
  const msg = ${JSON.stringify(READ_ONLY_MESSAGE)};
  window.__perchStrip = Element.prototype.removeAttribute;
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

export async function repl(tab: Tab, code: string): Promise<ReplResult> {
  const { root } = await tab.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
  const { outerHTML } = await tab.send<{ outerHTML: string }>("DOM.getOuterHTML", { nodeId: root.nodeId });
  const url = await tab.url();
  const scratch = await sandbox(tab.conn);
  const body = /\b(return|await)\b|^\s*(const|let|var|throw|if|for|while)\b/.test(code) ? code : `return (${code}\n);`;
  const expression = `(async () => {
    const isSecret = ${IS_SECRET_JS};
    const document = new DOMParser().parseFromString(${JSON.stringify(outerHTML)}, 'text/html');
    for (const el of document.querySelectorAll('input')) {
      if (isSecret(el) || /pass|card|cvc|cvv|otp|one.?time/i.test((el.getAttribute('name') || '') + ' ' + (el.id || ''))) window.__perchStrip.call(el, 'value');
    }
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
