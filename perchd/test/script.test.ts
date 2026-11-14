import { afterAll, beforeAll, expect, test } from "bun:test";
import { LIMITS, runScript } from "../src/agent/script";
import type { ApprovalRequest } from "../src/agent/session";
import { callTool } from "../src/agent/session";
import { newToolContext } from "../src/agent/tools";
import type { ToolCall } from "../src/models/types";
import { setup } from "./helpers";

const fake = (answers: Record<string, string>, seen: ToolCall[] = []) => async (c: ToolCall) => {
  seen.push(c);
  return c.name in answers ? { content: answers[c.name]! } : { content: `no ${c.name}`, isError: true };
};

test("a script calls tools in a row with loops, and returns what it logged and returned", async () => {
  const seen: ToolCall[] = [];
  const r = await runScript(
    `for (const q of ["a", "b"]) { await navigate("https://x.test/?q=" + q); log(q, await js("return 1")); }
     try { await click("e9"); } catch (e) { log("caught", e.message); }
     return { done: true };`,
    fake({ navigate: "Page: ok", repl: "1" }, seen),
  );
  expect(r.isError).toBeUndefined();
  expect(seen.map((c) => `${c.name} ${JSON.stringify(c.args)}`)).toEqual([
    'navigate {"url":"https://x.test/?q=a"}', 'repl {"code":"return 1"}', 'navigate {"url":"https://x.test/?q=b"}', 'repl {"code":"return 1"}', 'click {"ref":"e9"}',
  ]);
  expect(r.content).toContain("Ran 5 browser calls");
  expect(r.content).toContain("a 1\nb 1\ncaught no click");
  expect(r.content).toContain('"done": true');
});

test("named and trailing option arguments reach the tool", async () => {
  const seen: ToolCall[] = [];
  await runScript(`await type("e1", "hi", { submit: true }); await snapshot({ full: true }); await scroll(400); await wait_for({ seconds: 1 });`, fake({ type: "", snapshot: "", scroll: "", wait_for: "" }, seen));
  expect(seen.map((c) => c.args)).toEqual([{ ref: "e1", text: "hi", submit: true }, { full: true }, { dy: 400 }, { seconds: 1 }]);
});

test("a decline stops the script: later calls do not run", async () => {
  const seen: ToolCall[] = [];
  const call = async (c: ToolCall) => (seen.push(c), c.name === "click" ? { content: "The user declined this action. Do not try it again; ask or finish.", isError: true } : { content: "" });
  const r = await runScript(`try { await click("e1"); } catch {} await navigate("https://x.test"); log("after");`, call);
  expect(seen.map((c) => c.name)).toEqual(["click"]);
  expect(r.isError).toBe(true);
  expect(r.content).toContain("declined");
});

test("the sandbox has no host access, and errors name the line", async () => {
  const r = await runScript(`log(typeof fetch, typeof require, typeof process, typeof Bun, typeof setTimeout);\nundefinedThing();`, fake({}));
  expect(r.content).toContain("undefined undefined undefined undefined undefined");
  expect(r.isError).toBe(true);
  expect(r.content).toMatch(/ReferenceError.*undefinedThing.*line 2/);
});

test("limits: calls, CPU time and wall time", async () => {
  const calls = await runScript(`for (let i = 0; i < 50; i++) await snapshot();`, fake({ snapshot: "" }), "s", { ...LIMITS, calls: 3 });
  expect(calls.content).toContain("Ran 3 browser calls");
  expect(calls.content).toContain("used its 3 browser calls");
  const cpu = await runScript(`while (true) {}`, fake({}), "s", { ...LIMITS, cpuMs: 200 });
  expect(cpu.isError).toBe(true);
  expect(cpu.content).toMatch(/interrupted/i);
  const slow = async () => new Promise<never>(() => {});
  const wall = await runScript(`await snapshot();`, slow, "s", { ...LIMITS, ms: 300 });
  expect(wall.content).toContain("ran out of time");
});

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });
const noAudit = { append: async () => {} } as never;

test("in the browser, each scripted action is approved on its own", async () => {
  const ctx = await newToolContext(env.browser);
  const asked: string[] = [];
  const policy = { mode: "guard" as const, audit: noAudit, approve: async (r: ApprovalRequest) => (asked.push(r.summary), false) };
  const r = await callTool(ctx, policy, { id: "s", name: "script", args: { code: `
    await navigate(${JSON.stringify(env.site.url("/canvas-editor.html"))});
    await type_text("Hello "); await type_text("world");
    log(await js("return document.getElementById('cell').textContent"));
    await press("Enter");
    await type_text("never");` } });
  expect(await ctx.tab!.evaluate<string>("document.getElementById('cell').textContent")).toBe("Hello world");
  expect(r.content).toContain('"Hello world"');
  expect(r.content).toContain("declined");
  expect(asked.length).toBe(1);
  await ctx.close();
});

test("in the REPL a lone expression prints its value; statements still need return or log", async () => {
  const { ScriptVm, isLoneExpression } = await import("../src/agent/script");
  const vm = await ScriptVm.create();
  const noCalls = (async () => ({ content: "" })) as never;
  expect(await vm.run("1 + 1", noCalls, "r1", true)).toEqual({ content: "2" });
  expect(await vm.run("const x = 41", noCalls, "r2", true)).toEqual({ content: "(no output)" });
  expect(await vm.run("x + 1;", noCalls, "r3", true)).toEqual({ content: "42" });
  expect(isLoneExpression("if (a) b")).toBe(false);
  expect(isLoneExpression("a; b")).toBe(false);
  vm.dispose();
});
