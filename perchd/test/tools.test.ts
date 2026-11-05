import { afterAll, beforeAll, expect, test } from "bun:test";
import { checkCall, describeTarget, newToolContext, runTool, TOOL_SPECS } from "../src/agent/tools";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });

test("every tool spec is a strict JSON Schema object", () => {
  const names = TOOL_SPECS.map((s) => s.name);
  expect(names).toEqual(["navigate", "snapshot", "click", "type", "select", "press", "scroll", "hover", "upload", "wait_for", "back", "screenshot", "click_at", "repl", "tabs", "open_tab", "switch_tab", "done"]);
  for (const spec of TOOL_SPECS) {
    const p = spec.parameters as { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
    expect(p.type).toBe("object");
    expect(p.additionalProperties).toBe(false);
    for (const key of p.required ?? []) expect(Object.keys(p.properties)).toContain(key);
    expect(spec.description.length).toBeLessThan(240);
  }
});

test("bad calls come back as plain errors", async () => {
  const ctx = await newToolContext(env.browser);
  expect(await runTool(ctx, call("fly"))).toMatchObject({ isError: true, content: 'unknown tool "fly"' });
  expect(await runTool(ctx, call("click"))).toMatchObject({ isError: true, content: 'missing argument "ref"' });
  expect(await runTool(ctx, call("click", { ref: 12 }))).toMatchObject({ isError: true, content: 'argument "ref" must be a string' });
  expect(await runTool(ctx, call("click", { ref: "e1", color: "red" }))).toMatchObject({ isError: true, content: 'unexpected argument "color"' });
  expect(await runTool(ctx, call("click", { __unparsed: "{ref:" }))).toMatchObject({ isError: true, content: 'the arguments for "click" were not valid JSON' });
  expect(await runTool(ctx, call("click", { ref: "e1)(" }))).toMatchObject({ isError: true, content: 'ref "e1)(" is not a valid ref; refs look like e12' });
  for (const url of ["javascript:alert(document.cookie)", "data:text/html,<script>1</script>", "file:///etc/passwd", "chrome://settings", "JavaScript:void 0"]) {
    expect(await runTool(ctx, call("navigate", { url }))).toMatchObject({ isError: true });
    expect(await runTool(ctx, call("open_tab", { url }))).toMatchObject({ isError: true });
  }
  expect(checkCall(call("navigate", { url: "javascript:1" }))).toBe("Perch's agent only opens http and https pages");
  await ctx.close();
});

test("navigate adds https when needed and returns a snapshot; click returns the page after", async () => {
  const ctx = await newToolContext(env.browser);
  const opened = await runTool(ctx, call("navigate", { url: env.site.url("/mail.html") }));
  expect(opened.isError).toBeFalsy();
  expect(opened.content).toContain('button "Compose"');
  const ref = opened.content.match(/button "Compose" \[ref=(e\d+)\]/)![1]!;
  expect(describeTarget(ctx, call("click", { ref }))).toEqual({ role: "button", name: "Compose" });
  const clicked = await runTool(ctx, call("click", { ref }));
  expect(clicked.content).toContain('clicked button "Compose"');
  expect(clicked.content).toContain('textbox "To"');
  expect(await runTool(ctx, call("navigate", { url: "localhost:1" }))).toMatchObject({ isError: true });
  await ctx.close();
});

test("repl, screenshot, wait_for and tabs", async () => {
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/shop.html") }));
  expect((await runTool(ctx, call("repl", { code: "return document.title" }))).content).toBe('"Northwind Shop"');
  const shot = await runTool(ctx, call("screenshot"));
  expect(shot.image?.length).toBeGreaterThan(1000);
  expect((await runTool(ctx, call("wait_for", { text: "Travel adapter" }))).isError).toBeFalsy();
  const opened = await runTool(ctx, call("open_tab", { url: env.site.url("/mail.html") }));
  expect(opened.content).toContain("Mailroom");
  const listed = await runTool(ctx, call("tabs"));
  expect(listed.content).toMatch(/\* .*Mailroom/);
  const shopId = listed.content.match(/(\S+) Northwind Shop/)![1]!;
  expect((await runTool(ctx, call("switch_tab", { id: shopId }))).content).toContain("Travel adapter");
  await ctx.close();
});

test("done returns the final answer", async () => {
  const ctx = await newToolContext(env.browser);
  expect(await runTool(ctx, call("done", { answer: "Sent the reply." }))).toEqual({ content: "Sent the reply.", done: true });
  await ctx.close();
});
