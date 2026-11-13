import { afterAll, beforeAll, expect, test } from "bun:test";
import { newToolContext, runTool } from "../src/agent/tools";
import { foldRepeats } from "../src/page/repeats";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });

test("a click in a single-page app returns the page after its data arrives, not the loading state", async () => {
  const ctx = await newToolContext(env.browser);
  const opened = await runTool(ctx, call("navigate", { url: env.site.url("/portal.html") }));
  const ref = opened.content.match(/link "Eastern Part of Cities" \[ref=(e\d+)\]/)![1];
  const clicked = await runTool(ctx, call("click", { ref }));
  expect(clicked.content).toContain("Brainstorm doc: Not uploaded");
  expect(clicked.content).not.toContain("Loading…");
  await ctx.close();
});

test("a menu repeated from the last snapshot shows as one line that keeps its links and refs", async () => {
  const ctx = await newToolContext(env.browser);
  const first = await runTool(ctx, call("navigate", { url: env.site.url("/portal.html") }));
  expect(first.content).toMatch(/\n\s*- link "Calendar" \[ref=e\d+\]/);
  const again = await runTool(ctx, call("snapshot"));
  expect(again.content).toMatch(/- complementary "Main menu" \(same as the last snapshot\): Home \[e\d+\] · Calendar \[e\d+\]/);
  expect(again.content).not.toMatch(/\n\s*- link "Calendar"/);
  expect(again.content).toContain('link "Eastern Part of Cities"');
  const full = await runTool(ctx, call("snapshot", { full: true }));
  expect(full.content).toMatch(/\n\s*- link "Calendar" \[ref=e\d+\]/);
  await ctx.close();
});

test("foldRepeats leaves changed menus and small blocks alone", () => {
  const menu = (extra = "") => ['- navigation "Sections"', '  - link "Home" [ref=e1]', '  - link "Calendar" [ref=e2]', '  - link "Groups" [ref=e3]', `  - link "People${extra}" [ref=e4]`];
  const before = [...menu(), "- main", '  - heading "A" [level=1]'].join("\n");
  expect(foldRepeats([...menu(" (2)"), "- main"].join("\n"), before)).toContain('link "People (2)" [ref=e4]');
  const renumbered = [...menu()].map((l) => l.replace(/e(\d)/, "e1$1")).join("\n");
  expect(foldRepeats(renumbered, before)).toBe('- navigation "Sections" (same as the last snapshot): Home [e11] · Calendar [e12] · Groups [e13] · People [e14]');
  const small = '- navigation "Tabs"\n  - link "A" [ref=e1]';
  expect(foldRepeats(small, small)).toBe(small);
  expect(foldRepeats(before, undefined)).toBe(before);
});

test("a click at a point is judged by what is under it", async () => {
  const { liveTarget } = await import("../src/agent/tools");
  const { classify } = await import("../src/agent/permissions");
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/comment-dialog.html") }));
  const at = async (y: number) => {
    const c = call("click_at", { x: 100, y });
    const target = await liveTarget(ctx, c);
    return { target, kind: classify(c, target) };
  };
  expect(await at(40)).toEqual({ target: { role: "textbox", name: "Comment for Scarlett Zhang" }, kind: "change" });
  expect(await at(100)).toEqual({ target: { role: "button", name: "Done" }, kind: "change" });
  expect((await at(160)).kind).toBe("risky");
  expect(await at(220)).toEqual({ target: undefined, kind: "risky" });
  await ctx.close();
});

test("one script fills a dozen rows of a long table and their comment dialogs, using find", async () => {
  const { runScript } = await import("../src/agent/script");
  const ctx = await newToolContext(env.browser);
  await runTool(ctx, call("navigate", { url: env.site.url("/grades.html") }));
  const code = `
    const people = Array.from({ length: 12 }, (_, i) => "Student " + (i + 19));
    for (const p of people) {
      const [score] = await find("spinbutton", "Score for " + p + " on Thu");
      await type(score.ref, "0");
      const [add] = await find("button", "Add comment for " + p + " on Thu");
      await click(add.ref);
      const [box] = await find("textbox", "Comment for " + p);
      await type(box.ref, "Did not turn in brainstorming during class.");
      const [done] = await find("button", "Done");
      await click(done.ref);
    }
    const [save] = await find("button", "Save");
    await click(save.ref);
    log(await js("return document.getElementById('status').textContent"));`;
  const started = Date.now();
  const result = await runScript(code, (c) => runTool(ctx, c));
  const took = Date.now() - started;
  expect(result.isError).toBeFalsy();
  expect(result.content).toContain("Saved");
  const saved = await ctx.tab!.evaluate<Record<string, { score: string; comment: string }>>("window.saved");
  for (let i = 19; i <= 30; i++) expect(saved[`Student ${i}`]).toEqual({ score: "0", comment: "Did not turn in brainstorming during class." });
  expect(saved["Student 18"]).toEqual({ score: "20", comment: "" });
  console.log(`12 rows in ${took} ms`);
  await ctx.close();
}, 120_000);
