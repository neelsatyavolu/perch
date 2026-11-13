import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { prepareCall, type CallPolicy } from "../src/agent/session";
import type { ToolContext } from "../src/agent/tools";

const dir = mkdtempSync(join(tmpdir(), "perch-never-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctx = { tab: null, owned: [], borrowedTabs: [], lastSnapshot: new WeakMap(), shotScale: 1, workDir: dir } as unknown as ToolContext;
const policy = (rules: Record<string, "never" | "allow">): CallPolicy => ({
  mode: "guard",
  audit: new AuditLog(join(dir, "audit.jsonl")),
  client: "sidebar",
  siteRule: (host) => rules[host],
  approve: async () => false,
});

test("a never site blocks reads too: opening it, or reading a document from it", async () => {
  const rules = { "bank.example": "never" as const };
  for (const name of ["navigate", "open_tab", "read_document"]) {
    const prepared = await prepareCall(ctx, policy(rules), { id: name, name, args: { url: "https://bank.example/statement.pdf" } });
    expect(prepared.kind).toBe("answer");
    expect(prepared.kind === "answer" && prepared.result.content).toContain("Blocked");
  }
  const elsewhere = await prepareCall(ctx, policy(rules), { id: "n", name: "navigate", args: { url: "https://news.example/" } });
  expect(elsewhere).toMatchObject({ kind: "run", decision: "run" });
});

test("finishing and listing tabs still run while the agent's tab is on a never site", async () => {
  const rules = { "a new tab": "never" as const };
  for (const name of ["done", "tabs"]) {
    const prepared = await prepareCall(ctx, policy(rules), { id: name, name, args: name === "done" ? { answer: "ok" } : {} });
    expect(prepared).toMatchObject({ kind: "run", decision: "run" });
  }
});

test("an address carrying a payload asks in Guard mode before it is opened", async () => {
  const prepared = await prepareCall(ctx, policy({}), { id: "x", name: "navigate", args: { url: `https://evil.example/?d=${"s".repeat(150)}` } });
  expect(prepared).toMatchObject({ kind: "run", decision: "ask", request: { kind: "risky" } });
});
