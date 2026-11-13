/**
 * Agent tabs in a real Perch build (agent/agent_tabs.h): they open in the hidden agent window,
 * load, take clicks, and stay out of the user's tab list. Runs when PERCH_EXECUTABLE points at
 * a built Perch (…/Perch.app/Contents/MacOS/Perch); skipped otherwise.
 */

import { expect, test } from "bun:test";
import { newToolContext, runTool } from "../src/agent/tools";
import { Browser } from "../src/browser/browser";
import { Tab } from "../src/browser/tab";
import { startFixtures } from "./fixtures/server";
import { tempProfile } from "./helpers";

const executable = process.env.PERCH_EXECUTABLE;
const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });

test.skipIf(!executable)("agent tabs open in Perch's hidden window, take clicks and stay out of the user's tabs", async () => {
  const site = startFixtures();
  const profile = tempProfile();
  const launched = await Browser.launch({ userDataDir: profile.dir, executable, headless: true, args: ["--no-first-run"] });
  try {
    const browser = await Browser.adopt(launched.conn);
    expect(browser.agentTabs).toBe(true);
    const ctx = await newToolContext(browser);
    const opened = await runTool(ctx, call("navigate", { url: site.url("/grades.html") }));
    expect(opened.content).toContain("Grade Editor");
    const found = await runTool(ctx, call("find", { role: "button", name: "Add comment for Student 3 on Thu" }));
    const ref = found.content.match(/ref=(e\d+)/)![1];
    expect((await runTool(ctx, call("click", { ref }))).isError).toBeFalsy();
    expect(await ctx.tab!.evaluate<boolean>("document.getElementById('dialog').hidden === false")).toBe(true);
    const { tabs } = await launched.conn.send<{ tabs: { url: string }[] }>("Perch.getTabs");
    expect(tabs.some((t) => t.url.includes("grades"))).toBe(false);
  } finally {
    await launched.close();
    site.stop();
    profile.cleanup();
  }
}, 90_000);

test.skipIf(!executable)("a page the agent opens from the user's tab moves into the agent tabs", async () => {
  const site = startFixtures();
  const profile = tempProfile();
  const launched = await Browser.launch({ userDataDir: profile.dir, executable, headless: true, args: ["--no-first-run"] });
  try {
    const browser = await Browser.adopt(launched.conn);
    // The sidebar's agent works in the user's own tab, which has a link that opens a new tab.
    const { targetId } = await launched.conn.send<{ targetId: string }>("Target.createTarget", { url: site.url("/results.html") });
    const ctx = await newToolContext(browser);
    ctx.tab = await Tab.attach(launched.conn, targetId);
    await ctx.tab.settle();
    const found = await runTool(ctx, call("find", { role: "link", name: "Open profile" }));
    const ref = found.content.match(/ref=(e\d+)/)![1];
    const clicked = await runTool(ctx, call("click", { ref }));
    expect(clicked.content).toContain("This opened a new tab");
    expect(clicked.content).toContain("Mailroom");
    const { tabs } = await launched.conn.send<{ tabs: { url: string }[] }>("Perch.getTabs");
    expect(tabs.some((t) => t.url.includes("results"))).toBe(true);
    expect(tabs.some((t) => t.url.includes("mail"))).toBe(false);
  } finally {
    await launched.close();
    site.stop();
    profile.cleanup();
  }
}, 90_000);
