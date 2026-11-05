import { afterAll, beforeAll, expect, test } from "bun:test";
import { newToolContext, runTool } from "../src/agent/tools";
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

async function board() {
  const ctx = await newToolContext(env.browser);
  const page = (await runTool(ctx, call("navigate", { url: env.site.url("/drag.html") }))).content;
  const out = () => ctx.tab!.evaluate<string>("document.getElementById('out').textContent");
  return { ctx, page, out };
}

test("type sets a native range slider to the nearest allowed value", async () => {
  const { ctx, page, out } = await board();
  const r = await runTool(ctx, call("type", { ref: refIn(page, 'slider "Max price"'), text: "$420" }));
  expect(r.content).toStartWith("set the slider to 400 (the nearest value it allows to 420)");
  expect(await out()).toBe("Price: 400");
  await ctx.close();
});

test("type moves an ARIA slider with the arrow keys", async () => {
  const { ctx, page, out } = await board();
  const ref = refIn(page, 'slider "Minimum rating"');
  expect((await runTool(ctx, call("type", { ref, text: "7" }))).content).toStartWith("set the slider to 7");
  expect(await out()).toBe("Rating: 7");
  expect((await runTool(ctx, call("type", { ref, text: "2" }))).content).toStartWith("set the slider to 2");
  expect((await runTool(ctx, call("type", { ref, text: "lots" }))).content).toBe("this is a slider from 0 to 10; give a number");
  await ctx.close();
});

test("an ARIA slider too fine to reach with the keys reports where it stopped", async () => {
  const { ctx, page } = await board();
  const r = await runTool(ctx, call("type", { ref: refIn(page, 'slider "Budget"'), text: "4000" }));
  expect(r.isError).toBe(true);
  expect(r.content).toBe("the slider stopped at 400 after 400 key presses; drag its handle the rest of the way");
  await ctx.close();
}, 30_000);

test("drag by an offset moves a mouse-driven handle", async () => {
  const { ctx, page, out } = await board();
  const r = await runTool(ctx, call("drag", { ref: refIn(page, 'button "Distance handle"'), dx: 120, dy: 0 }));
  expect(r.isError).toBeFalsy();
  expect(await out()).toBe("Handle at 120");
  await ctx.close();
});

test("drag onto a drop zone delivers an HTML5 drop with the drag's data", async () => {
  const { ctx, page, out } = await board();
  const r = await runTool(ctx, call("drag", { ref: refIn(page, 'button "Card one"'), to: refIn(page, 'button "Done column"') }));
  expect(r.isError).toBeFalsy();
  expect(await out()).toBe("Dropped: card-1");
  expect(await runTool(ctx, call("drag", { ref: refIn(page, 'button "Card one"') }))).toMatchObject({ isError: true, content: "give to (a ref to drop on) or dx and dy (pixels to move)" });
  await ctx.close();
});

test("a drop target too far from the source to show with it is an error, not a drag to the wrong place", async () => {
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/drag-far.html") }));
  const page = (await runTool(ctx, call("snapshot", { full: true }))).content;
  const r = await runTool(ctx, call("drag", { ref: refIn(page, 'button "Card one"'), to: refIn(page, 'button "Archive column"') }));
  expect(r.isError).toBe(true);
  expect(r.content).toContain("are not on screen together");
  expect(await ctx.tab!.evaluate<string>("document.getElementById('out').textContent")).toBe("");
  await ctx.close();
});
