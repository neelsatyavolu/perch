import { afterAll, beforeAll, expect, test } from "bun:test";
import { newToolContext, runTool, UNCHANGED } from "../src/agent/tools";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });
const refIn = (text: string, label: string) => {
  const m = text.match(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[ref=(e\\d+)\\]`));
  if (!m) throw new Error(`no ${label} in\n${text}`);
  return m[1]!;
};

test("scrolling a lazy list says when more loaded and when the end is reached", async () => {
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/lazy.html") }));
  const first = await runTool(ctx, call("scroll", { dy: 100_000 }));
  expect(first.content).toMatch(/^scrolled the page to \d+ of \d+ px; more content loaded at the end/);
  let last = first.content;
  for (let i = 0; i < 8 && !last.includes("this is the end of the page"); i++) last = (await runTool(ctx, call("scroll", { dy: 100_000 }))).content;
  expect(last).toContain("this is the end of the page");
  expect(last).toContain("End of results");
  const again = await runTool(ctx, call("scroll", { dy: 500 }));
  expect(again.content).toStartWith("the page did not move: it is at the end");
  await ctx.close();
}, 30_000);

test("a click that changes nothing is pointed out; one that does is not", async () => {
  const ctx = await newToolContext(env.browser);
  const opened = await runTool(ctx, call("navigate", { url: env.site.url("/lazy.html") }));
  const dead = await runTool(ctx, call("click", { ref: refIn(opened.content, 'button "Apply"') }));
  expect(dead.content).toContain(UNCHANGED);
  const live = await runTool(ctx, call("click", { ref: refIn(opened.content, 'checkbox "Rating 4 and up"') }));
  expect(live.content).not.toContain(UNCHANGED);
  await ctx.close();
});

test("a gone ref comes back with the page as it is now", async () => {
  const ctx = await newToolContext(env.browser);
  const opened = await runTool(ctx, call("navigate", { url: env.site.url("/mail.html") }));
  const maya = refIn(opened.content, 'link "Maya Chen · Design review Thursday?"');
  await runTool(ctx, call("click", { ref: refIn(opened.content, 'button "Refresh"') }));
  const gone = await runTool(ctx, call("click", { ref: maya }));
  expect(gone.isError).toBe(true);
  expect(gone.content).toStartWith(`ref ${maya} is gone`);
  expect(gone.content).toContain("Page: ");
  expect(gone.content).toContain('button "Compose"');
  await ctx.close();
});
