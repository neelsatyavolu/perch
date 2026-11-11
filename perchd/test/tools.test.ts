import { afterAll, beforeAll, expect, test } from "bun:test";
import { checkCall, describeTarget, newToolContext, runTool, TOOL_SPECS } from "../src/agent/tools";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });

test("every tool spec is a strict JSON Schema object", () => {
  const names = TOOL_SPECS.map((s) => s.name);
  expect(names).toEqual(["navigate", "snapshot", "click", "type", "select", "press", "scroll", "drag", "hover", "upload", "write_file", "wait_for", "back", "screenshot", "click_at", "repl", "type_text", "save_pdf", "downloads", "tabs", "open_tab", "switch_tab", "done", "sign_in", "fill_card", "fill_code"]);
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
  expect(await runTool(ctx, call("click"))).toMatchObject({ isError: true, content: 'missing argument "ref"; click takes ref' });
  expect(await runTool(ctx, call("scroll", { direction: "down" }))).toMatchObject({ isError: true, content: 'unexpected argument "direction"; scroll takes dy (pixels, negative is up), ref' });
  expect(await runTool(ctx, call("click", { ref: 12 }))).toMatchObject({ isError: true, content: 'argument "ref" must be a string' });
  expect(await runTool(ctx, call("click", { ref: "e1", color: "red" }))).toMatchObject({ isError: true, content: 'unexpected argument "color"; click takes ref' });
  expect(await runTool(ctx, call("click", { __unparsed: "{ref:" }))).toMatchObject({ isError: true, content: 'the arguments for "click" were not valid JSON' });
  expect(await runTool(ctx, call("click", { ref: "e1)(" }))).toMatchObject({ isError: true, content: 'ref "e1)(" is not a valid ref; refs look like e12' });
  for (const url of ["javascript:alert(document.cookie)", "data:text/html,<script>1</script>", "file:///etc/passwd", "chrome://settings", "JavaScript:void 0"]) {
    expect(await runTool(ctx, call("navigate", { url }))).toMatchObject({ isError: true });
    expect(await runTool(ctx, call("open_tab", { url }))).toMatchObject({ isError: true });
  }
  expect(checkCall(call("navigate", { url: "javascript:1" }))).toBe("Perch's agent only opens http and https pages");
  await ctx.close();
});

test("describeTarget notes when the element opens a menu", () => {
  const tab = {};
  const ctx = { tab, lastSnapshot: new Map([[tab, '- button "Book" [ref=e10] expanded=false\n- link "Deals" [ref=e11]']]) } as never;
  expect(describeTarget(ctx, call("click", { ref: "e10" }))).toEqual({ role: "button", name: "Book", expanded: false });
  expect(describeTarget(ctx, call("click", { ref: "e11" }))).toEqual({ role: "link", name: "Deals" });
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

test("write_file saves into the chat's own folder and nowhere else", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const ctx = await newToolContext(env.browser);
  const made = await runTool(ctx, call("write_file", { name: "resume.txt", content: "Maya Chen, designer" }));
  const path = made.content.match(/saved (\S+)/)![1]!;
  expect(path.startsWith(ctx.workDir)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("Maya Chen, designer");
  const escaped = await runTool(ctx, call("write_file", { name: "../../etc/evil", content: "x" }));
  expect(escaped.content).toMatch(/saved (\S+)/);
  expect(escaped.content.match(/saved (\S+)/)![1]!.startsWith(ctx.workDir)).toBe(true);
  expect(existsSync("/etc/evil")).toBe(false);
  await ctx.close();
  expect(existsSync(ctx.workDir)).toBe(false);
});

test("wait_for can wait a few seconds and returns the page after", async () => {
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/shop.html") }));
  const started = Date.now();
  const waited = await runTool(ctx, call("wait_for", { seconds: 1 }));
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(waited.content).toContain("waited 1 s");
  expect(waited.content).toContain("Page: Northwind Shop");
  expect(await runTool(ctx, call("wait_for", {}))).toMatchObject({ isError: true, content: "give text to wait for, or seconds to wait" });
  await ctx.close();
});

test("the REPL says plainly that it has no network", async () => {
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/shop.html") }));
  for (const code of ["return await (await fetch('/w/api.php')).text()", "return await (await fetch('https://example.com/data.json')).json()"]) {
    const r = await runTool(ctx, call("repl", { code }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("the REPL has no network access");
    expect(r.content).toContain("navigate");
  }
  await ctx.close();
});

test("type_text types at the focus, save_pdf writes a PDF to Downloads, downloads lists it", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "perch-dl-"));
  const before = process.env.PERCH_DOWNLOADS_DIR;
  process.env.PERCH_DOWNLOADS_DIR = dir;
  const ctx = await newToolContext(env.browser);
  try {
    await runTool(ctx, call("navigate", { url: env.site.url("/canvas-editor.html") }));
    expect((await runTool(ctx, call("type_text", { text: "=SUM(A1:A3)" }))).isError).toBeFalsy();
    expect(await ctx.tab!.evaluate<string>("document.getElementById('cell').textContent")).toBe("=SUM(A1:A3)");
    const saved = await runTool(ctx, call("save_pdf", { name: "Cast bios" }));
    expect(saved.content).toBe(`saved ${join(dir, "Cast bios.pdf")}`);
    expect(readFileSync(join(dir, "Cast bios.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await runTool(ctx, call("save_pdf", { name: "Cast bios" }))).content).toBe(`saved ${join(dir, "Cast bios 2.pdf")}`);
    const listed = (await runTool(ctx, call("downloads"))).content;
    expect(listed).toContain(join(dir, "Cast bios 2.pdf"));
    expect(listed.indexOf("Cast bios 2.pdf")).toBeLessThan(listed.indexOf("Cast bios.pdf"));
  } finally {
    await ctx.close();
    if (before === undefined) delete process.env.PERCH_DOWNLOADS_DIR;
    else process.env.PERCH_DOWNLOADS_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
