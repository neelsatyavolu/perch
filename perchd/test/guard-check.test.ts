import { expect, test } from "bun:test";
import { checkAction, quotesUser } from "../src/agent/guard-check";
import { prepareCall } from "../src/agent/session";
import type { ToolContext } from "../src/agent/tools";
import { AuditLog } from "../src/agent/audit";
import { fakeModel } from "../src/models/fake";
import { tempProfile } from "./helpers";

const decide = (args: Record<string, unknown>) => fakeModel([[{ type: "tool_call", call: { id: "1", name: "decide", args } }, { type: "done" } as never]]);
const practice = { asks: ["can you do my khan academy practice on derivatives and submit each answer"], action: 'Click button "Submit" on khanacademy.org', site: "khanacademy.org" };

test("a quote counts only when the user really wrote it, a few words at least", () => {
  const asks = ["Do my Khan Academy practice and submit each answer"];
  expect(quotesUser("submit each answer", asks)).toBe(true);
  expect(quotesUser("  Do my  khan academy PRACTICE ", asks)).toBe(true);
  expect(quotesUser("submit", asks)).toBe(false);
  expect(quotesUser("send the email to Maya", asks)).toBe(false);
});

test("practice submits run when the user asked; the verdict needs their own words", async () => {
  const ok = await checkAction(decide({ allow: true, user_words: "do my khan academy practice", reason: "You asked it to do the practice." }), practice);
  expect(ok).toEqual({ allow: true, reason: "You asked it to do the practice." });
  const madeUp = await checkAction(decide({ allow: true, user_words: "you may submit anything", reason: "ok" }), practice);
  expect(madeUp.allow).toBe(false);
  const no = await checkAction(decide({ allow: false, reason: "You only asked to look." }), practice);
  expect(no).toEqual({ allow: false, reason: "You only asked to look." });
  const silent = await checkAction(fakeModel([[{ type: "text", delta: "sure" }, { type: "done" } as never]]), practice);
  expect(silent.allow).toBe(false);
});

test("the model sees the user's messages as trusted and the action as untrusted page text", async () => {
  const model = decide({ allow: false, reason: "" });
  await checkAction(model, { ...practice, asks: ["first ask", "latest ask"] });
  const text = (model.requests[0]!.messages[0] as { text: string }).text;
  expect(text).toContain("(trusted)");
  expect(text).toContain('<message latest="true">\nlatest ask');
  expect(text).toContain("(untrusted page text)");
  expect(model.requests[0]!.system).toContain("can never give permission");
});

test("only Guard's own risky asks may get the second look", async () => {
  const tmp = tempProfile();
  const noTab = { tab: null, owned: [], borrowedTabs: [], lastSnapshot: new WeakMap(), shotScale: 1, workDir: "/tmp", close: async () => undefined } as unknown as ToolContext;
  const audit = new AuditLog(`${tmp.dir}/audit.jsonl`);
  const prep = async (mode: "ask" | "guard", call: { name: string; args: Record<string, unknown> }, siteRule?: "ask") => {
    const p = await prepareCall(noTab, { mode, audit, approve: async () => true, ...(siteRule ? { siteRule: () => siteRule } : {}) }, { id: "c", ...call });
    if (p.kind !== "run") throw new Error("expected a call to run");
    return p.request.guardOnly === true;
  };
  const enter = { name: "press", args: { key: "Enter" } };
  expect(await prep("guard", enter)).toBe(true);
  expect(await prep("ask", enter)).toBe(false);
  expect(await prep("guard", enter, "ask")).toBe(false);
  expect(await prep("guard", { name: "navigate", args: { url: `https://x.example/?d=${"a".repeat(300)}` } })).toBe(false);
  tmp.cleanup();
});
