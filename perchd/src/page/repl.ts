/**
 * Runs the model's JavaScript in an isolated world of the page. The world sees the page's DOM
 * but has its own copies of the DOM prototypes, so the guard below cannot be undone by the page,
 * and the page's own scripts are unaffected. Reading a secret field's value throws "secret field".
 */

import type { Tab } from "../browser/tab";
import { IS_SECRET_JS } from "./secrets";

export type ReplResult = { result: unknown; error?: string };

const GUARD = `(() => {
  if (globalThis.__perchGuarded) return;
  const isSecret = ${IS_SECRET_JS};
  const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    get() { if (isSecret(this)) throw new Error('secret field'); return value.get.call(this); },
    set(v) { value.set.call(this, v); },
    configurable: false,
  });
  const NativeFormData = FormData;
  globalThis.FormData = class extends NativeFormData {
    constructor(form, submitter) {
      super(form, submitter);
      if (form) for (const el of form.querySelectorAll('input')) if (isSecret(el) && el.name) this.delete(el.name);
    }
  };
  globalThis.__perchGuarded = true;
})()`;

async function isolatedContext(tab: Tab): Promise<number> {
  const { frameTree } = await tab.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  const { executionContextId } = await tab.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "perch-repl",
  });
  await tab.send("Runtime.evaluate", { expression: GUARD, contextId: executionContextId });
  return executionContextId;
}

export async function repl(tab: Tab, code: string): Promise<ReplResult> {
  const contextId = await isolatedContext(tab);
  const expression = /\b(return|await)\b|^\s*(const|let|var|throw)\b/.test(code) ? `(async () => { ${code}\n})()` : code;
  const res = await tab.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, contextId, returnByValue: true, awaitPromise: true, timeout: 30_000 },
  );
  if (res.exceptionDetails) {
    const description = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    return { result: undefined, error: description.split("\n")[0]!.replace(/^(Uncaught )?Error: /, "") };
  }
  return { result: res.result.value };
}
