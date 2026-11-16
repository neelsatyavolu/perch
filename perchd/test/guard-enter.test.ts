import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ApprovalRequest } from "../src/agent/session";
import { callTool } from "../src/agent/session";
import { newToolContext, type ToolContext } from "../src/agent/tools";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
let ctx: ToolContext;
const asked: ApprovalRequest[] = [];
const noAudit = { append: async () => {} } as never;
const guard = { mode: "guard" as const, audit: noAudit, approve: async (r: ApprovalRequest) => (asked.push(r), false) };

beforeAll(async () => {
  env = await setup();
  ctx = await newToolContext(env.browser);
  await callTool(ctx, guard, { id: "n", name: "navigate", args: { url: env.site.url("/guard-enter.html") } });
});
afterAll(async () => {
  await ctx.close();
  await env.teardown();
});

/** Focuses a field and presses Enter in Guard mode; true when Perch asked first. */
async function enterAsks(id: string): Promise<boolean> {
  await ctx.tab!.evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
  const before = asked.length;
  await callTool(ctx, guard, { id: `p-${id}`, name: "press", args: { key: "Enter" } });
  return asked.length > before;
}

test("typing a time and pressing Enter in a maps field runs without asking", async () => {
  const snap = await callTool(ctx, guard, { id: "s", name: "snapshot", args: {} });
  const ref = snap.content.match(/textbox "7:00 AM" \[ref=(\w+)\]/)?.[1];
  expect(ref).toBeDefined();
  const before = asked.length;
  await callTool(ctx, guard, { id: "t", name: "type", args: { ref, text: "7:00 AM", submit: true } });
  expect(asked.length).toBe(before);
});

test("Enter in a search form, a place field or a date field does not ask", async () => {
  expect(await enterAsks("time")).toBe(false);
  expect(await enterAsks("q")).toBe(false);
  expect(await enterAsks("from")).toBe(false);
  expect(await enterAsks("date")).toBe(false);
});

test("Enter that posts a comment, sends a chat message, signs up or orders still asks", async () => {
  expect(await enterAsks("comment")).toBe(true);
  expect(await enterAsks("chat")).toBe(true);
  expect(await enterAsks("email")).toBe(true);
  expect(await enterAsks("promo")).toBe(true);
  expect(asked.at(-1)!.kind).toBe("payment");
});

test("Enter on a focused submit button is judged by that button, and a research form is not a search", async () => {
  expect(await enterAsks("nick")).toBe(false);
  expect(await enterAsks("close")).toBe(true);
  expect(await enterAsks("topic")).toBe(true);
});

test("an approved Archive is not asked again in the same task; Delete asks every time, and Ask mode always asks", async () => {
  const snap = await callTool(ctx, guard, { id: "s2", name: "snapshot", args: {} });
  const ref = (name: string) => snap.content.match(new RegExp(`button "${name}" \\[ref=(\\w+)\\]`))?.[1];
  const clicks = async (mode: "guard" | "ask", name: string) => {
    const seen: string[] = [];
    const policy = { mode, audit: noAudit, approve: async (r: ApprovalRequest) => (seen.push(r.summary), true) };
    for (const id of ["a", "b"]) await callTool(ctx, policy, { id, name: "click", args: { ref: ref(name) } });
    return seen.length;
  };
  expect(await clicks("guard", "Archive")).toBe(1);
  expect(await clicks("guard", "Delete")).toBe(2);
  expect(await clicks("ask", "Archive")).toBe(2);
}, 20_000);
