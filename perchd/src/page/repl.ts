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
import { rememberedSecrets, secretKey } from "./secrets";

export type ReplResult = { result: unknown; error?: string };

export const NO_NETWORK_MESSAGE =
  "the REPL has no network access: it reads a copy of the page. To read an API, a feed or another page, open its URL with navigate or open_tab (JSON and text pages work too), then read it";
const NETWORK_ERROR = /Failed to fetch|Failed to parse URL|NetworkError|XMLHttpRequest|ERR_BLOCKED|WebSocket/i;

const FIELDS_UNREADABLE = "the page changed while the REPL was reading it; try again";

export const READ_ONLY_MESSAGE = "the REPL is read-only; use click, type and select to change the page";

const LOCK_DOWN = `(() => {
  if (window.__perchLocked) return;
  const msg = ${JSON.stringify(READ_ONLY_MESSAGE)};
  window.__perchStrip = Element.prototype.removeAttribute;
  // Puts the live page's field values on the copy; kept before the setters below are blocked.
  const setter = (proto, n) => Object.getOwnPropertyDescriptor(proto, n).set;
  const sets = { input: setter(HTMLInputElement.prototype, 'value'), area: setter(HTMLTextAreaElement.prototype, 'value'), checked: setter(HTMLInputElement.prototype, 'checked'), selected: setter(HTMLOptionElement.prototype, 'selected') };
  const text = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').set;
  const removeChild = Node.prototype.removeChild;
  window.__perchClear = (el) => {
    if (el.tagName === 'TEXTAREA') { text.call(el, ''); sets.area.call(el, ''); }
    else if (el.tagName === 'SELECT') while (el.firstChild) removeChild.call(el, el.firstChild);
    else { window.__perchStrip.call(el, 'value'); sets.input.call(el, ''); }
  };
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
      // A hidden target has no window or tab, so the user never sees it (a new window would get its
      // own Space beside a full-screen one). Older browsers without hidden targets get a window.
      const { targetId } = await conn
        .send<{ targetId: string }>("Target.createTarget", { url: "about:blank", hidden: true, background: true })
        .catch(() => conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true, background: true }));
      Tab.hidden.add(targetId);
      const tab = await Tab.attach(conn, targetId);
      await tab.send("Network.enable");
      await tab.send("Network.setBlockedURLs", { urls: ["*"] });
      return tab;
    })();
    sandboxes.set(conn, pending);
  }
  const tab = await pending;
  if (!tab.closed) return tab;
  sandboxes.delete(conn);
  return sandbox(conn);
}

/** How long one REPL call may run. */
const REPL_LIMIT_MS = 10_000;

/** Stops whatever runs in the scratch tab and closes it; the next call makes a new one. */
async function discardSandbox(conn: CdpConnection, scratch: Tab): Promise<void> {
  sandboxes.delete(conn);
  await scratch.send("Runtime.terminateExecution").catch(() => undefined);
  await conn.send("Target.closeTarget", { targetId: scratch.id }).catch(() => undefined);
}

const worldsMade = new WeakMap<Tab, number>();
/** A world's name picks it: the same name gives back the same world, so each one gets its own. */
let worldSerial = 0;
/** Worlds stay until the scratch tab navigates; it is reset after this many. */
const WORLDS_PER_RESET = 100;

/**
 * Every REPL call runs in a world of its own on the scratch tab: code from one call cannot leave
 * anything behind (a replaced helper or prototype) that changes how the next copy is cleaned.
 */
async function freshWorld(scratch: Tab): Promise<number> {
  const made = (worldsMade.get(scratch) ?? 0) + 1;
  if (made > WORLDS_PER_RESET) {
    await scratch.send("Page.navigate", { url: "about:blank" });
    worldsMade.set(scratch, 1);
  } else worldsMade.set(scratch, made);
  const { frameTree } = await scratch.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  const { executionContextId } = await scratch.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: `perch-repl-${++worldSerial}` });
  await scratch.send("Runtime.evaluate", { expression: LOCK_DOWN, contextId: executionContextId });
  return executionContextId;
}

/** A field's identity: the copy's fields are matched to the live page's by position and this. */
const FIELD_KEY = `(el) => [el.tagName, el.getAttribute('type') || '', el.getAttribute('name') || '', el.id || ''].join('|')`;
/**
 * Secret fields of any kind: passwords, and inputs, text areas or selects marked as card,
 * password or one-time-code fields, or named like one.
 */
const IS_SECRET_ANY = `(el) => {
  if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password') return true;
  if ((el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).some((t) => /^(cc-.+|one-time-code|current-password|new-password)$/.test(t))) return true;
  return /pass|card|cvc|cvv|otp|one.?time/i.test((el.getAttribute('name') || '') + ' ' + (el.id || ''));
}`;
const FIND_SECRETS = `function () {
  const isSecret = ${IS_SECRET_ANY};
  return [...this.querySelectorAll('input, textarea, select')].filter(isSecret);
}`;
const READ_FIELDS = `function (...skip) {
  const isSecret = ${IS_SECRET_ANY};
  const key = ${FIELD_KEY};
  return [...this.querySelectorAll('input, textarea, select')].map((el) => {
    if (skip.includes(el) || isSecret(el)) return [key(el), 'secret'];
    if (el.tagName === 'SELECT') return [key(el), { selected: [...el.options].map((o) => o.selected) }];
    if (el.type === 'checkbox' || el.type === 'radio') return [key(el), { checked: el.checked }];
    if (el.type === 'file') return [key(el), { files: [...(el.files || [])].map((f) => f.name) }];
    return [key(el), { value: el.value }];
  });
}`;

type FieldState = [string, { value?: string; checked?: boolean; selected?: boolean[]; files?: string[] } | "secret"];

/**
 * What the user and the agent have typed, chosen and ticked: an HTML copy only has the values the
 * page loaded with, so without this a filled form reads as empty. It is read in an isolated world,
 * where the page's own scripts cannot replace the getters, so reading runs none of the page's
 * code. Secret fields found here are remembered, so they stay secret once shown as text; fields
 * that are or were secret give no state, and the copy strips theirs.
 */
async function liveFields(tab: Tab, rootNodeId: number): Promise<FieldState[] | null> {
  try {
    const { frameTree } = await tab.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const { executionContextId } = await tab.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "perch-repl-fields" });
    const resolve = async (node: { nodeId?: number; backendNodeId?: number }) =>
      (await tab.send<{ object: { objectId: string } }>("DOM.resolveNode", { ...node, executionContextId })).object.objectId;
    const doc = await resolve({ nodeId: rootNodeId });
    const remembered = rememberedSecrets(tab);
    const found = await tab.send<{ result: { objectId?: string } }>("Runtime.callFunctionOn", { objectId: doc, functionDeclaration: FIND_SECRETS, returnByValue: false });
    if (found.result.objectId) {
      const { result } = await tab.send<{ result: { name: string; value?: { objectId?: string } }[] }>("Runtime.getProperties", { objectId: found.result.objectId, ownProperties: true });
      for (const prop of result) {
        if (!/^\d+$/.test(prop.name) || !prop.value?.objectId) continue;
        const { node } = await tab.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId: prop.value.objectId });
        remembered.add(secretKey(node.backendNodeId));
      }
    }
    const secrets: { objectId: string }[] = [];
    for (const key of remembered) {
      if (!key.startsWith("main:")) continue;
      try {
        secrets.push({ objectId: await resolve({ backendNodeId: Number(key.slice(5)) }) });
      } catch {
        // The field is gone.
      }
    }
    const res = await tab.send<{ result: { value?: FieldState[] } }>("Runtime.callFunctionOn", { objectId: doc, functionDeclaration: READ_FIELDS, arguments: secrets, returnByValue: true });
    return res.result.value ?? null;
  } catch {
    return null;
  }
}

export async function repl(tab: Tab, code: string): Promise<ReplResult> {
  const { root } = await tab.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
  const { outerHTML } = await tab.send<{ outerHTML: string }>("DOM.getOuterHTML", { nodeId: root.nodeId });
  const fields = await liveFields(tab, root.nodeId);
  // Without the field list the copy cannot tell which fields hold secrets, so nothing runs.
  if (!fields) return { result: undefined, error: FIELDS_UNREADABLE };
  const url = await tab.url();
  const scratch = await sandbox(tab.conn);
  const body = /\b(return|await)\b|^\s*(const|let|var|throw|if|for|while)\b/.test(code) ? code : `return (${code}\n);`;
  // The copy is made and cleaned first, by code of ours alone. The model's code is compiled on its
  // own afterwards and given only the cleaned copy, so it cannot reach the raw HTML.
  const clean = `(() => {
    const isSecret = ${IS_SECRET_ANY};
    const document = new DOMParser().parseFromString(${JSON.stringify(outerHTML)}, 'text/html');
    const fields = ${JSON.stringify(fields)};
    const key = ${FIELD_KEY};
    const copied = [...document.querySelectorAll('input, textarea, select')];
    // Secret fields lose what the HTML held. A field the live page marks secret is cleared here
    // wherever a field with its identity sits, in case the copy parsed in a different order.
    const secretKeys = new Set(fields.filter((f) => f[1] === 'secret').map((f) => f[0]));
    for (const el of copied) if (isSecret(el) || secretKeys.has(key(el))) window.__perchClear(el);
    // Fields are matched by position and identity; a copy that parsed differently is left as is.
    copied.forEach((el, i) => {
      const live = fields[i];
      if (live && live[1] !== 'secret' && live[0] === key(el) && !secretKeys.has(key(el))) window.__perchFill(el, live[1]);
    });
    return document;
  })()`;
  const contextId = await freshWorld(scratch);
  const copy = await scratch.send<{ result: { objectId?: string } }>("Runtime.evaluate", { expression: clean, contextId, returnByValue: false });
  if (!copy.result.objectId) return { result: undefined, error: FIELDS_UNREADABLE };
  type Run = { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  // A syntax error is the person's code's own, not the wrapper's: `1+` says "Unexpected end of input".
  // Checked by the page's own engine, which words it as the person will see it run.
  const syntax = (await syntaxError(scratch, contextId, body)) && ((await scriptError(scratch, contextId, code)) || "the code has a syntax error");
  if (syntax) return { result: undefined, error: syntax };
  const running = scratch.send<Run>("Runtime.callFunctionOn", {
    functionDeclaration: `async function (document, href) {\n const location = new URL(href);\n const __value = await (async () => {\n ${body}\n })();\n return (${SERIALIZE})(__value);\n }`,
    executionContextId: contextId,
    arguments: [{ objectId: copy.result.objectId }, { value: url }],
    returnByValue: true,
    awaitPromise: true,
  });
  // Code that never finishes (an endless loop) would hold the one scratch tab every later call
  // uses: past the limit it is stopped and the tab thrown away, so the next call gets a fresh one.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), REPL_LIMIT_MS)));
  const res = await Promise.race([running.catch((error: unknown) => ({ failed: error }) as const), late]).finally(() => clearTimeout(timer));
  if (res === "late") {
    await discardSandbox(tab.conn, scratch);
    return { result: undefined, error: `the code ran for more than ${REPL_LIMIT_MS / 1000}s and was stopped` };
  }
  if ("failed" in res) {
    await discardSandbox(tab.conn, scratch);
    throw res.failed;
  }
  if (res.exceptionDetails) {
    const description = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    const first = description.split("\n")[0]!.replace(/^(Uncaught )?(Type)?Error: /, "");
    return { result: undefined, error: NETWORK_ERROR.test(first) ? NO_NETWORK_MESSAGE : first };
  }
  // The value came back as JSON text made in the page (SERIALIZE); undefined stays undefined.
  const text = res.result.value;
  return { result: typeof text === "string" ? JSON.parse(text) : undefined };
}

/** The person's code parsed exactly as written, for a syntax error that names their code's own place. */
async function scriptError(scratch: Tab, contextId: number, code: string): Promise<string> {
  const r = await scratch
    .send<{ exceptionDetails?: { exception?: { description?: string }; text?: string } }>("Runtime.compileScript", { expression: code, sourceURL: "", persistScript: false, executionContextId: contextId })
    .catch(() => null);
  const d = r?.exceptionDetails;
  return (d?.exception?.description ?? d?.text ?? "").split("\n")[0]!.replace(/^(Uncaught )?SyntaxError: /, "");
}

/** The message of a syntax error in `code` as an async function body, from the page's engine; "" when it parses. */
async function syntaxError(scratch: Tab, contextId: number, code: string): Promise<string> {
  const expression = `(() => { try { new (Object.getPrototypeOf(async function () {}).constructor)('document', 'href', ${JSON.stringify(code)}); return ''; } catch (e) { return e instanceof SyntaxError ? e.message : ''; } })()`;
  const r = await scratch.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, contextId, returnByValue: true }).catch(() => null);
  return typeof r?.result.value === "string" ? r.result.value : "";
}

/**
 * Turns the result into JSON text in the page, so anything comes back readable: dates as ISO
 * text, BigInts as "12n", Maps and Sets as lists, functions and symbols named, repeats as
 * "[Circular]", and very deep or very big values cut off rather than failing.
 */
const SERIALIZE = `(value) => {
  if (value === undefined) return undefined;
  const seen = new WeakSet();
  const walk = (v, depth) => {
    if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString() + 'n';
    if (typeof v === 'undefined') return null;
    if (typeof v === 'function') return '[Function' + (v.name ? ' ' + v.name : '') + ']';
    if (typeof v === 'symbol') return v.toString();
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
    if (v instanceof Error) return v.name + ': ' + v.message;
    if (typeof Node !== 'undefined' && v instanceof Node) return '[' + (v.nodeName || 'Node') + ']';
    if (seen.has(v)) return '[Circular]';
    if (depth > 8) return '[…]';
    seen.add(v);
    if (v instanceof Map) return [...v].slice(0, 1000).map(([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]);
    if (v instanceof Set || Array.isArray(v) || ArrayBuffer.isView(v)) return [...v].slice(0, 1000).map((x) => walk(x, depth + 1));
    if (typeof Window !== 'undefined' && v instanceof Window) return '[Window]';
    const out = {};
    for (const k of Object.keys(v).slice(0, 1000)) { try { out[k] = walk(v[k], depth + 1); } catch { out[k] = '[unreadable]'; } }
    return out;
  };
  return JSON.stringify(walk(value, 0));
}`;
