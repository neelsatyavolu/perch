import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { mockKeychain } from "../src/memory/keychain";
import { fakeModel } from "../src/models/fake";
import type { Message, TurnEvent, TurnRequest } from "../src/models/types";
import { runRoutine } from "../src/routines/runner";
import { RoutineStore, type Routine } from "../src/routines/store";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
let dir: string;
beforeAll(async () => {
  env = await setup();
  dir = mkdtempSync(join(tmpdir(), "perch-routine-browser-"));
});
afterAll(async () => {
  await env.teardown();
  rmSync(dir, { recursive: true, force: true });
});

const tool = (name: string, args: Record<string, unknown>): TurnEvent[] => [{ type: "tool_call", call: { id: `${name}-${Math.random()}`, name, args } }, { type: "done" }];
const lastTool = (req: TurnRequest) => [...req.messages].reverse().find((m): m is Extract<Message, { role: "tool" }> => m.role === "tool")!.content;

test("an unattended routine in Skip mode still never pays: Place order is declined on a real page", async () => {
  const store = await RoutineStore.open(join(dir, "routines"), mockKeychain(), "default");
  const routine: Routine = {
    id: "0123456789abcdef0123456789abcdef",
    name: "Reorder adapter",
    task: "Buy the travel adapter",
    schedule: { kind: "cron", expr: "0 8 * * 1" },
    enabled: true,
    mode: "skip",
    missed: "run_once",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastRunAt: null,
    nextRunAt: null,
  };
  await store.save(routine);
  const model = fakeModel([
    () => tool("navigate", { url: env.site.url("/shop.html") }),
    (req) => tool("click", { ref: /button "Place order" \[ref=(e\d+)\]/.exec(lastTool(req))![1] }),
    (req) => tool("done", { answer: lastTool(req).includes("declined") ? "Could not place the order without approval." : "Ordered." }),
    () => tool("done", { answer: "Could not place the order without approval." }),
  ]);
  const run = await runRoutine(routine, "schedule", {
    store,
    audit: new AuditLog(join(dir, "audit.jsonl")),
    browser: async () => env.browser,
    model: async () => model,
  });
  expect(run.status).toBe("needs_approval");
  expect(run.declined).toEqual(['Click button "Place order" on 127.0.0.1']);
  expect(run.answer).toBe("Could not place the order without approval.");
});
