import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { REPEATED } from "../src/agent/progress";
import { serverArgs } from "../src/external";
import { createServer } from "../src/mcp";
import { tempProfile } from "./helpers";

const profile = tempProfile();
const server = createServer({
  profileDir: join(profile.dir, "profile"),
  headless: true,
  budget: { maxMs: 1 },
  policy: { mode: "guard", audit: new AuditLog(join(profile.dir, "audit.jsonl")), approve: async () => false },
});
afterAll(async () => {
  await server.close();
  profile.cleanup();
});

let id = 0;
const callTool = async (name: string, args: object = {}) => {
  const reply = (await server.message({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as { result: { content: { text: string }[] } };
  return reply.result.content[0]!.text;
};

test("MCP results carry the time budget once, and a note when a call keeps failing the same way", async () => {
  const first = await callTool("tabs");
  expect(first).toStartWith("Budget: about 0 of 0 minutes left. Answer now");
  expect(await callTool("click", { ref: "e999" })).not.toContain("Budget:");
  await callTool("click", { ref: "e999" });
  expect(await callTool("click", { ref: "e999" })).toStartWith(REPEATED);
}, 30_000);

test("outside agents get a time budget a minute short of their limit", () => {
  expect(serverArgs({ task: "x", timeoutMs: 15 * 60_000, auditPath: "/tmp/a" }).slice(0, 2)).toEqual(["--time-budget-s", "840"]);
  expect(serverArgs({ task: "x", timeoutMs: 60_000, auditPath: "/tmp/a" }).slice(0, 2)).toEqual(["--time-budget-s", "30"]);
});
