import { expect, test } from "bun:test";
import { ReplSessions } from "../src/agent/repl";
import type { ToolCall } from "../src/models/types";

const TAB = "61C542D39CC218621219486E3B198A69";

function browser(seen: ToolCall[] = []) {
  let page = "Page: A\n- link \"x\" [ref=e1]";
  return async (c: ToolCall) => {
    seen.push(c);
    switch (c.name) {
      case "open_tab": return { content: "opened" };
      case "tabs": return { content: `* ${TAB} Example · https://example.com/ (yours)\n  7B97DAFE55F99FF5858374F6C4E09A42 New tab · perch://newtab/ (the user's)` };
      case "snapshot": return { content: page };
      case "click": page = "Page: B\n- link \"y\" [ref=e2]"; return { content: "clicked" };
      case "repl": return { content: JSON.stringify(String(c.args.code).includes("location") ? "https://example.com/" : 42) };
      default: return { content: "" };
    }
  };
}

test("variables, pages and snapshots carry over between runs of one session", async () => {
  const repls = new ReplSessions();
  const seen: ToolCall[] = [];
  const call = browser(seen);
  const first = await repls.run("cli/a", `const p1 = await openTab("https://example.com"); const s1 = await snapshot(p1); let count = 1; function twice(n) { return n * 2 }`, call);
  expect(first.isError).toBeUndefined();
  const second = await repls.run("cli/a", `count += 1; await p1.locator("e1").click(); const s2 = await snapshot(p1); log(twice(count), s2.diff, await p1.url(), page === p1)`, call);
  expect(second.content).toContain("4 + Page: B");
  expect(second.content).toContain("- Page: A");
  expect(second.content).toContain("https://example.com/ true");
  expect(seen.filter((c) => c.name === "click")[0]!.args).toEqual({ ref: "e1" });
  const tabs = await repls.run("cli/a", `log((await listBrowserTabs()).map((t) => t.owner + ":" + t.current))`, call);
  expect(tabs.content).toContain('"yours:true"');
  const other = await repls.run("cli/b", `log(typeof p1)`, call);
  expect(other.content).toContain("undefined");
  expect(repls.reset("cli/a")).toBe(true);
  expect((await repls.run("cli/a", `log(typeof count)`, call)).content).toContain("undefined");
  repls.close();
});

test("a bad ref, a thrown error and a redeclared name are reported plainly", async () => {
  const repls = new ReplSessions();
  const call = browser();
  await repls.run("k", `const p1 = await openTab("https://example.com")`, call);
  expect((await repls.run("k", `p1.locator("button.buy")`, call)).content).toContain("takes a ref");
  expect((await repls.run("k", `throw new Error("nope")`, call)).content).toMatch(/Error: nope/);
  const again = await repls.run("k", `const p1 = "replaced"; log(p1)`, call);
  expect(again.content).toContain("replaced");
  repls.close();
});
