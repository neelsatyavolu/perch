import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ApprovalRequest } from "../src/agent/session";
import { callTool } from "../src/agent/session";
import { newToolContext } from "../src/agent/tools";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const noAudit = { append: async () => {} } as never;

test("batch runs known actions in a row, each approved on its own, and stops at a decline", async () => {
  const ctx = await newToolContext(env.browser);
  const asked: string[] = [];
  const policy = { mode: "guard" as const, audit: noAudit, approve: async (r: ApprovalRequest) => (asked.push(r.summary), false) };
  await callTool(ctx, policy, { id: "n", name: "navigate", args: { url: env.site.url("/canvas-editor.html") } });
  // Two typing actions run without asking (changes in Guard); pressing Enter in the editor is risky and is declined.
  const r = await callTool(ctx, policy, { id: "b", name: "batch", args: { actions: [
    { name: "type_text", args: { text: "Hello " } },
    { name: "type_text", args: { text: "world" } },
    { name: "press", args: { key: "Enter" } },
    { name: "type_text", args: { text: "never" } },
  ] } });
  expect(await ctx.tab!.evaluate<string>("document.getElementById('cell').textContent")).toBe("Hello world");
  expect(r.isError).toBe(true);
  expect(r.content).toContain("Ran type_text, type_text; then action 3 (press) stopped the batch");
  expect(asked.length).toBe(1);
  // Only the usual actions, and not too many.
  expect((await callTool(ctx, policy, { id: "x", name: "batch", args: { actions: [{ name: "upload", args: {} }] } })).content).toContain("batch can run");
  expect((await callTool(ctx, policy, { id: "y", name: "batch", args: { actions: Array.from({ length: 11 }, () => ({ name: "scroll", args: { dy: 10 } })) } })).content).toContain("at most 10");
  await ctx.close();
});
