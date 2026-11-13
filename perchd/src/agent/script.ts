/**
 * The script tool and the REPL: JavaScript that calls Perch's browser tools in a row, with loops
 * and checks between them, so one model turn (or one `perch repl` line) can do what took several.
 * The code runs in QuickJS (WebAssembly), which has no files, network, timers or host objects: it
 * reaches the browser only through the functions below, and each of those is an ordinary tool call,
 * checked, approved and audited.
 */

import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import type { ToolCall } from "../models/types";
import { declaredNames } from "./script-names";
import type { ToolResult } from "./tools";

export const SCRIPT = "script";

/** Tools a script may call, by the name the script uses. `js` is the page repl. */
const FUNCTIONS: Record<string, string> = {
  navigate: "navigate", snapshot: "snapshot", find: "find", click: "click", type: "type", select: "select", press: "press",
  scroll: "scroll", hover: "hover", drag: "drag", type_text: "type_text", wait_for: "wait_for", back: "back",
  tabs: "tabs", open_tab: "open_tab", switch_tab: "switch_tab", js: "repl",
};
const TOOL_NAMES = new Set(Object.values(FUNCTIONS));
/** How each function's positional arguments map onto the tool's named ones. */
const POSITIONAL: Record<string, string[]> = {
  navigate: ["url"], find: ["role", "name"], click: ["ref"], type: ["ref", "text"], select: ["ref", "value"], press: ["key"], hover: ["ref"],
  drag: ["ref", "to"], type_text: ["text"], open_tab: ["url"], switch_tab: ["id"], js: ["code"], scroll: ["dy"], wait_for: ["text"],
};

export type ScriptLimits = { calls: number; ms: number; cpuMs: number; memory: number; output: number; sleepS: number };
export const LIMITS: ScriptLimits = { calls: 120, ms: 300_000, cpuMs: 5_000, memory: 32 * 1024 * 1024, output: 30_000, sleepS: 10 };

type Call = (c: ToolCall) => Promise<ToolResult>;

const PRELUDE = `
globalThis.__out = [];
globalThis.__vars = {};
const __fmt = (v) => typeof v === "string" ? v : JSON.stringify(v, null, 1);
const log = (...a) => { globalThis.__out.push(a.map(__fmt).join(" ")); };
const display = log;
const console = { log, info: log, warn: log, error: log };
const __tool = async (name, args) => { const r = JSON.parse(await __call(name, JSON.stringify(args))); if (r.error) throw new Error(r.content); return r.content; };
const __fn = (name, keys) => async (...a) => {
  const args = a.length === 1 && a[0] && typeof a[0] === "object" && !Array.isArray(a[0]) ? a[0] : Object.fromEntries(keys.map((k, i) => [k, a[i]]).filter(([, v]) => v !== undefined));
  if (a.length > keys.length && a.at(-1) && typeof a.at(-1) === "object") Object.assign(args, a.at(-1));
  return __tool(name, args);
};
const sleep = (s) => __sleep(Number(s) || 0);
${Object.keys(FUNCTIONS)
  .map((f) => `globalThis.${f} = __fn(${JSON.stringify(f)}, ${JSON.stringify(POSITIONAL[f] ?? [])});`)
  .join("\n")}
// find returns the elements as objects, so a script can use f.ref directly.
{ const __find = globalThis.find; globalThis.find = async (...a) => { const text = await __find(...a); return [...text.matchAll(/^- (\\S+) "((?:[^"\\\\]|\\\\.)*)" \\[ref=(e\\d+)\\]$/gm)].map((m) => ({ ref: m[3], role: m[1], name: m[2].replace(/\\\\(.)/g, "$1") })); }; }
`;

let wasm: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => (wasm ??= newQuickJSWASMModuleFromVariant(variant));

/**
 * One QuickJS context. `runScript` uses one per script; the REPL keeps one per session, so its
 * top-level `const`, `let`, functions and classes carry over from one run to the next.
 */
export class ScriptVm {
  private call: Call = async () => ({ content: "No browser here.", isError: true });
  private ran: string[] = [];
  private stopped = "";
  private pending = 0;
  private cpuDeadline = 0;
  private disposed = false;
  /** Names earlier runs declared at the top level, carried into the next run (REPL only). */
  private known: string[] = [];

  private constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly vm: QuickJSContext,
    private readonly limits: ScriptLimits,
  ) {}

  static async create(limits: ScriptLimits = LIMITS, extra = ""): Promise<ScriptVm> {
    const module = await quickjs();
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.memory);
    runtime.setMaxStackSize(1024 * 1024);
    const s = new ScriptVm(runtime, runtime.newContext(), limits);
    // CPU time inside QuickJS only; waiting on the browser does not count.
    runtime.setInterruptHandler(() => Date.now() > s.cpuDeadline);
    s.install();
    s.cpuDeadline = Date.now() + limits.cpuMs;
    const ev = s.vm.evalCode(`${PRELUDE}\n${extra}`, "prelude.js");
    if (ev.error) {
      const text = JSON.stringify(s.vm.dump(ev.error));
      ev.error.dispose();
      s.dispose();
      throw new Error(`The script sandbox did not start: ${text}`);
    }
    ev.value.dispose();
    return s;
  }

  private pump(): void {
    if (!this.vm.alive) return;
    this.cpuDeadline = Date.now() + this.limits.cpuMs;
    this.runtime.executePendingJobs();
  }

  private async settle(deferred: ReturnType<QuickJSContext["newPromise"]>, ok: boolean, value: string): Promise<void> {
    // Never inside the host function that made the promise: its handle must be returned first.
    await Promise.resolve();
    this.pending--;
    if (!this.vm.alive) return;
    const h = ok ? this.vm.newString(value) : this.vm.newError(value);
    if (ok) deferred.resolve(h);
    else deferred.reject(h);
    h.dispose();
    deferred.dispose();
    this.pump();
  }

  private install(): void {
    const vm = this.vm;
    const callFn = vm.newFunction("__call", (nameH: QuickJSHandle, argsH: QuickJSHandle) => {
      const fn = vm.getString(nameH);
      const deferred = vm.newPromise();
      this.pending++;
      // Scripts use the friendly names (js); the REPL's own helpers use the tool names (repl).
      const tool = FUNCTIONS[fn] ?? (TOOL_NAMES.has(fn) ? fn : undefined);
      const answer = (r: ToolResult) => void this.settle(deferred, true, JSON.stringify({ content: r.content, error: Boolean(r.isError) }));
      if (this.stopped) answer({ content: this.stopped, isError: true });
      else if (!tool) answer({ content: `unknown function ${fn}`, isError: true });
      else if (this.ran.length >= this.limits.calls) {
        this.stopped = `The script used its ${this.limits.calls} browser calls; split the work into another run.`;
        answer({ content: this.stopped, isError: true });
      } else {
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(vm.getString(argsH));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          // Unparseable arguments reach the tool as none, and its own check names what is missing.
        }
        this.ran.push(fn);
        this.call({ id: `${this.runId}.${this.ran.length}`, name: tool, args })
          .then((r) => {
            if (r.isError && /declined/i.test(r.content)) this.stopped = r.content;
            answer(r);
          })
          .catch((e: unknown) => answer({ content: e instanceof Error ? e.message : String(e), isError: true }));
      }
      return deferred.handle;
    });
    vm.setProp(vm.global, "__call", callFn);
    callFn.dispose();

    const sleepFn = vm.newFunction("__sleep", (sH: QuickJSHandle) => {
      const s = Math.min(Math.max(vm.getNumber(sH), 0), this.limits.sleepS);
      const deferred = vm.newPromise();
      this.pending++;
      setTimeout(() => void this.settle(deferred, true, ""), s * 1000);
      return deferred.handle;
    });
    vm.setProp(vm.global, "__sleep", sleepFn);
    sleepFn.dispose();
  }

  private runId = "script";

  /**
   * Runs `code` as the body of an async function and returns what it logged and returned. The
   * run stops at the first decline, and when its calls, time or memory run out. With `persist`,
   * top-level declarations stay for the next run (REPL).
   */
  async run(code: string, call: Call, id = "script", persist = false): Promise<ToolResult> {
    if (this.disposed) return { content: "This session's JavaScript was reset. Run it again.", isError: true };
    this.call = call;
    this.runId = id;
    this.ran = [];
    this.stopped = "";
    const start = Date.now();
    const declared = persist ? declaredNames(code) : [];
    const carried = this.known.filter((n) => !declared.includes(n));
    const all = [...new Set([...this.known, ...declared])];
    // Earlier runs' names come back as `let`s; a closure made first saves every name at the end,
    // including those this run declares further down (it sees them once they are initialised).
    const head = persist
      ? [
          carried.length ? `let ${carried.map((n) => `${n} = globalThis.__vars[${JSON.stringify(n)}]`).join(", ")};` : "",
          `globalThis.__saveVars = () => { ${all.map((n) => `try { globalThis.__vars[${JSON.stringify(n)}] = ${n}; } catch {}`).join(" ")} };`,
        ].join("\n")
      : "";
    const before = `globalThis.__out = [];\nglobalThis.__main = (async () => {\n${head}\n`;
    const source = `${before}${code}\n})();`;
    const offset = before.split("\n").length - 1;

    let output = "";
    let failure = "";
    try {
      this.cpuDeadline = Date.now() + this.limits.cpuMs;
      const ev = this.vm.evalCode(source, "script.js");
      if (ev.error) {
        failure = errorText(this.vm, ev.error, offset);
        ev.error.dispose();
        if (/redeclaration|already been declared/i.test(failure)) failure += ". A name stays defined across runs here; use a new name.";
      } else {
        ev.value.dispose();
        const main = this.vm.getProp(this.vm.global, "__main");
        const done = this.vm.resolvePromise(main);
        main.dispose();
        this.pump();
        const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), Math.max(0, this.limits.ms - (Date.now() - start))).unref?.());
        const settled = await Promise.race([done, timeout]);
        if (settled === "timeout") {
          this.stopped = `The script ran out of time (${Math.round(this.limits.ms / 1000)} s).`;
          failure = this.stopped;
        } else if (settled.error) {
          failure = errorText(this.vm, settled.error, offset);
          settled.error.dispose();
        } else {
          const v = this.vm.dump(settled.value);
          settled.value.dispose();
          if (v !== undefined) output = typeof v === "string" ? v : JSON.stringify(v, null, 1);
        }
        if (persist) {
          this.cpuDeadline = Date.now() + this.limits.cpuMs;
          const saved = this.vm.evalCode("globalThis.__saveVars && globalThis.__saveVars();", "save.js");
          if (saved.error) saved.error.dispose();
          else saved.value.dispose();
          this.known = all;
        }
      }
      const outH = this.vm.getProp(this.vm.global, "__out");
      const logged = this.vm.dump(outH) as unknown;
      outH.dispose();
      const lines = Array.isArray(logged) ? logged.map(String) : [];
      output = [lines.join("\n"), output].filter(Boolean).join("\n");
    } catch (e) {
      failure ||= e instanceof Error ? e.message : String(e);
    }

    const head2 = this.ran.length ? `Ran ${this.ran.length} browser ${this.ran.length === 1 ? "call" : "calls"} (${this.ran.join(", ")}).` : persist ? "" : "Made no browser calls.";
    const body = output.length > this.limits.output ? `${output.slice(0, this.limits.output)}… (${output.length.toLocaleString("en-US")} characters, cut)` : output;
    const empty = failure || persist ? "" : "The script logged nothing; log() what you need to see.";
    const text = [head2, body || empty, failure && `Error: ${failure}`].filter(Boolean).join("\n\n");
    return failure ? { content: text, isError: true } : { content: text || "(no output)" };
  }

  /** Frees the context; calls still in flight answer into nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped ||= "The script ended.";
    if (this.pending > 0) return;
    try {
      this.vm.dispose();
      this.runtime.dispose();
    } catch {
      // A leaked handle only matters to this throwaway runtime.
    }
  }
}

/** One script in a fresh context (the `script` tool). */
export async function runScript(code: string, call: Call, id = "script", limits = LIMITS): Promise<ToolResult> {
  const vm = await ScriptVm.create(limits);
  try {
    return await vm.run(code, call, id);
  } finally {
    vm.dispose();
  }
}

function errorText(vm: QuickJSContext, h: QuickJSHandle, offset: number): string {
  const e = vm.dump(h) as { name?: string; message?: string; stack?: string } | string;
  if (typeof e === "string") return e;
  const where = e?.stack?.match(/script\.js:(\d+)/)?.[1];
  return `${e?.name ?? "Error"}: ${e?.message ?? String(e)}${where ? ` (line ${Number(where) - offset})` : ""}`;
}
