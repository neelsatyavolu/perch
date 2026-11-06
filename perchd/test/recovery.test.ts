import { afterAll, beforeAll, expect, test } from "bun:test";
import { newToolContext, runTool } from "../src/agent/tools";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });

test("a tab whose page locks up is replaced by a fresh tab on the same page", async () => {
  const ctx = await newToolContext(env.browser);
  const opened = await runTool(ctx, call("navigate", { url: env.site.url("/freeze.html") }));
  const ref = opened.content.match(/button "Freeze" \[ref=(e\d+)\]/)![1]!;
  const frozen = ctx.tab!;
  frozen.timeoutMs = 2000;
  const result = await runTool(ctx, call("click", { ref }));
  expect(result.content).toContain("stopped responding");
  expect(result.content).toContain("new tab");
  expect(result.content).toContain('heading "Freezer"');
  expect(ctx.tab).not.toBe(frozen);
  expect(ctx.owned).not.toContain(frozen);
  const after = await runTool(ctx, call("snapshot"));
  expect(after.isError).toBeFalsy();
  expect(after.content).toContain("freeze.html");
  await ctx.close();
}, 60_000);

test("a slow page that is still responding is not replaced", async () => {
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/shop.html") }));
  const tab = ctx.tab!;
  const conn = tab.conn;
  const send = conn.send.bind(conn);
  // One command that never answers, on a page that otherwise answers at once.
  tab.timeoutMs = 1000;
  conn.send = ((method: string, params?: object, session?: string) =>
    method === "DOM.getDocument" && session === tab.session ? new Promise(() => undefined) : send(method, params, session)) as typeof conn.send;
  const result = await runTool(ctx, call("snapshot"));
  conn.send = send;
  expect(result.isError).toBe(true);
  expect(ctx.tab).toBe(tab);
  await ctx.close();
}, 60_000);
