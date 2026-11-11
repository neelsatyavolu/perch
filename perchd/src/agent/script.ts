/**
 * The script tool: a few lines of JavaScript that call Perch's browser tools in a row, with loops
 * and checks between them, so one model turn can do what took several (search two queries and
 * read both, open each result and pull its price). The code runs in QuickJS (WebAssembly), which
 * has no files, network, timers or host objects: it can reach the browser only through the
 * functions below, and each of those is an ordinary tool call, checked, approved and audited.
 */

import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core";
import type { ToolCall } from "../models/types";
import type { ToolResult } from "./tools";

export const SCRIPT = "script";

/** Tools a script may call, by the name the script uses. `js` is the page repl. */
const FUNCTIONS: Record<string, string> = {
  navigate: "navigate", snapshot: "snapshot", click: "click", type: "type", select: "select", press: "press",
  scroll: "scroll", hover: "hover", drag: "drag", type_text: "type_text", wait_for: "wait_for", back: "back",
  tabs: "tabs", open_tab: "open_tab", switch_tab: "switch_tab", js: "repl",
};
/** How each function's positional arguments map onto the tool's named ones. */
const POSITIONAL: Record<string, string[]> = {
  navigate: ["url"], click: ["ref"], type: ["ref", "text"], select: ["ref", "value"], press: ["key"], hover: ["ref"],
  drag: ["ref", "to"], type_text: ["text"], open_tab: ["url"], switch_tab: ["id"], js: ["code"], scroll: ["dy"], wait_for: ["text"],
};

export const LIMITS = { calls: 40, ms: 120_000, cpuMs: 5_000, memory: 32 * 1024 * 1024, output: 30_000, sleepS: 10 };

const PRELUDE = `
const __out = globalThis.__out = [];
const __fmt = (v) => typeof v === "string" ? v : JSON.stringify(v, null, 1);
const log = (...a) => { __out.push(a.map(__fmt).join(" ")); };
const console = { log, info: log, warn: log, error: log };
const __tool = async (name, args) => { const r = JSON.parse(await __call(name, JSON.stringify(args))); if (r.error) throw new Error(r.content); return r.content; };
const __fn = (name, keys) => async (...a) => {
  const args = a.length === 1 && a[0] && typeof a[0] === "object" && !Array.isArray(a[0]) ? a[0] : Object.fromEntries(keys.map((k, i) => [k, a[i]]).filter(([, v]) => v !== undefined));
  if (a.length > keys.length && a.at(-1) && typeof a.at(-1) === "object") Object.assign(args, a.at(-1));
  return __tool(name, args);
};
const sleep = (s) => __sleep(Number(s) || 0);
`;

let wasm: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => (wasm ??= newQuickJSWASMModuleFromVariant(variant));

/**
 * Runs `code` (the body of an async function) and returns what it logged and returned. `call`
 * runs one tool; the script stops at the first decline, and when its calls, time or memory run out.
 */
export async function runScript(code: string, call: (c: ToolCall) => Promise<ToolResult>, id = "script", limits = LIMITS): Promise<ToolResult> {
  const module = await quickjs();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memory);
  runtime.setMaxStackSize(1024 * 1024);
  const vm = runtime.newContext();
  const ran: string[] = [];
  let stopped = "";
  let pending = 0;
  const start = Date.now();
  // CPU time inside QuickJS only; waiting on the browser does not count.
  let cpuDeadline = Date.now() + limits.cpuMs;
  runtime.setInterruptHandler(() => Date.now() > cpuDeadline);
  const pump = () => {
    if (!vm.alive) return;
    cpuDeadline = Date.now() + limits.cpuMs;
    runtime.executePendingJobs();
  };
  const settle = async (deferred: ReturnType<QuickJSContext["newPromise"]>, ok: boolean, value: string) => {
    // Never inside the host function that made the promise: its handle must be returned first.
    await Promise.resolve();
    pending--;
    if (!vm.alive) return;
    const h = ok ? vm.newString(value) : vm.newError(value);
    if (ok) deferred.resolve(h);
    else deferred.reject(h);
    h.dispose();
    deferred.dispose();
    pump();
  };

  const callFn = vm.newFunction("__call", (nameH: QuickJSHandle, argsH: QuickJSHandle) => {
    const fn = vm.getString(nameH);
    const deferred = vm.newPromise();
    pending++;
    const tool = FUNCTIONS[fn];
    const answer = (r: ToolResult) => void settle(deferred, true, JSON.stringify({ content: r.content, error: Boolean(r.isError) }));
    if (stopped) answer({ content: stopped, isError: true });
    else if (!tool) answer({ content: `unknown function ${fn}`, isError: true });
    else if (ran.length >= limits.calls) {
      stopped = `The script used its ${limits.calls} browser calls; split the work into another script.`;
      answer({ content: stopped, isError: true });
    } else {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(vm.getString(argsH));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        // Unparseable arguments reach the tool as none, and its own check names what is missing.
      }
      ran.push(fn);
      call({ id: `${id}.${ran.length}`, name: tool, args })
        .then((r) => {
          if (r.isError && /declined/i.test(r.content)) stopped = r.content;
          answer(r);
        })
        .catch((e: unknown) => answer({ content: e instanceof Error ? e.message : String(e), isError: true }));
    }
    return deferred.handle;
  });
  vm.setProp(vm.global, "__call", callFn);
  callFn.dispose();

  const sleepFn = vm.newFunction("__sleep", (sH: QuickJSHandle) => {
    const s = Math.min(Math.max(vm.getNumber(sH), 0), limits.sleepS);
    const deferred = vm.newPromise();
    pending++;
    setTimeout(() => void settle(deferred, true, ""), s * 1000);
    return deferred.handle;
  });
  vm.setProp(vm.global, "__sleep", sleepFn);
  sleepFn.dispose();

  const fns = Object.keys(FUNCTIONS)
    .map((f) => `const ${f} = __fn(${JSON.stringify(f)}, ${JSON.stringify(POSITIONAL[f] ?? [])});`)
    .join("\n");
  const before = `${PRELUDE}\n${fns}\nglobalThis.__main = (async () => {\n`;
  const source = `${before}${code}\n})();`;
  const offset = before.split("\n").length - 1;

  let output = "";
  let failure = "";
  try {
    const ev = vm.evalCode(source, "script.js");
    if (ev.error) {
      failure = errorText(vm, ev.error, offset);
      ev.error.dispose();
    } else {
      ev.value.dispose();
      const main = vm.getProp(vm.global, "__main");
      const done = vm.resolvePromise(main);
      main.dispose();
      pump();
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), Math.max(0, limits.ms - (Date.now() - start))).unref?.());
      const settled = await Promise.race([done, timeout]);
      if (settled === "timeout") {
        stopped = `The script ran out of time (${Math.round(limits.ms / 1000)} s).`;
        failure = stopped;
      } else if (settled.error) {
        failure = errorText(vm, settled.error, offset);
        settled.error.dispose();
      } else {
        const v = vm.dump(settled.value);
        settled.value.dispose();
        if (v !== undefined) output = typeof v === "string" ? v : JSON.stringify(v, null, 1);
      }
    }
    const outH = vm.getProp(vm.global, "__out");
    const logged = vm.dump(outH) as unknown;
    outH.dispose();
    const lines = Array.isArray(logged) ? logged.map(String) : [];
    output = [lines.join("\n"), output].filter(Boolean).join("\n");
  } catch (e) {
    failure ||= e instanceof Error ? e.message : String(e);
  } finally {
    // Calls still in flight answer into a dead context; settle() checks vm.alive.
    if (pending === 0) {
      try {
        vm.dispose();
        runtime.dispose();
      } catch {
        // A leaked handle only matters to this throwaway runtime.
      }
    } else stopped ||= "The script ended.";
  }

  const head = ran.length ? `Ran ${ran.length} browser ${ran.length === 1 ? "call" : "calls"} (${ran.join(", ")}).` : "Made no browser calls.";
  const body = output.length > limits.output ? `${output.slice(0, limits.output)}… (${output.length.toLocaleString("en-US")} characters, cut)` : output;
  const text = [head, body || (failure ? "" : "The script logged nothing; log() what you need to see."), failure && `Error: ${failure}`].filter(Boolean).join("\n\n");
  return failure ? { content: text, isError: true } : { content: text };
}

function errorText(vm: QuickJSContext, h: QuickJSHandle, offset: number): string {
  const e = vm.dump(h) as { name?: string; message?: string; stack?: string } | string;
  if (typeof e === "string") return e;
  const where = e?.stack?.match(/script\.js:(\d+)/)?.[1];
  return `${e?.name ?? "Error"}: ${e?.message ?? String(e)}${where ? ` (line ${Number(where) - offset})` : ""}`;
}
