import { afterAll, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentToolSpecs } from "../src/apps/index";
import { checkFlint, flintKind, runFlint } from "../src/apps/flint";
import { AuditLog } from "../src/agent/audit";
import { classify } from "../src/agent/permissions";
import { callTool, type CallPolicy } from "../src/agent/session";
import { TOOL_SPECS, type ToolContext } from "../src/agent/tools";
import { tempProfile } from "./helpers";

const dir = tempProfile();
afterAll(() => dir.cleanup());

const bin = join(dir.dir, "flint");
const calls = join(dir.dir, "calls.txt");
writeFileSync(
  bin,
  `#!/bin/sh
echo "$FLINT_AGENT $*" >> "${calls}"
case "$1" in
  status) echo "2 accounts, synced";;
  send) echo "Send 7: awaiting_approval";;
  read) [ "$2" = "404" ] && { echo "not_found: no thread 404" >&2; exit 1; }; echo "Thread $2";;
  folders) exit 2;;
  *) echo "ok $1";;
esac
`,
);
chmodSync(bin, 0o755);
const env = { PERCH_FLINT_BIN: bin, PATH: "/usr/bin:/bin", HOME: dir.dir };

test("only known flint commands run, and options that read files or change the actor are refused", () => {
  expect(checkFlint({ command: "list", args: ["--unread"] })).toBeNull();
  expect(checkFlint({ command: "watch" })).toContain('flint has no "watch" command');
  expect(checkFlint({ command: "draft", args: ["--body-file", "/etc/passwd"] })).toBe("--body-file is not allowed from Perch");
  expect(checkFlint({ command: "list", args: ["--as=someone"] })).toBe("--as is not allowed from Perch");
  expect(flintKind({ command: "search" })).toBe("read");
  expect(flintKind({ command: "reply" })).toBe("change");
  expect(flintKind({ command: "send" })).toBe("risky");
  expect(classify({ id: "1", name: "flint", args: { command: "archive" } })).toBe("risky");
});

test("the tool runs flint as Perch and reports Flint's state plainly", async () => {
  expect(await runFlint({ command: "status" }, env)).toEqual({ content: "2 accounts, synced" });
  expect(await runFlint({ command: "read", args: ["404"] }, env)).toEqual({ content: "not_found: no thread 404", isError: true });
  expect(await runFlint({ command: "folders" }, env)).toEqual({ content: "Flint is not running. Ask the user to open it.", isError: true });
  expect(readFileSync(calls, "utf8").split("\n")[0]).toBe("perch status --as perch");
  expect(await runFlint({ command: "status" }, { HOME: dir.dir, PATH: "" })).toMatchObject({ isError: true });
});

test("the agent sees the flint tool only when flint is installed", () => {
  expect(agentToolSpecs(TOOL_SPECS, env).map((t) => t.name)).toContain("flint");
  expect(agentToolSpecs(TOOL_SPECS, { HOME: join(dir.dir, "none") }).map((t) => t.name)).not.toContain("flint");
});

test("through Perch's rules: reads run, sends ask, and the audit names Flint", async () => {
  process.env.PERCH_FLINT_BIN = bin;
  const asked: string[] = [];
  const policy: CallPolicy = { mode: "guard", audit: new AuditLog(join(dir.dir, "audit.jsonl")), client: "sidebar", approve: async (r) => (asked.push(r.summary), false) };
  const ctx = { tab: null, owned: [], lastSnapshot: new WeakMap(), shotScale: 1, workDir: dir.dir } as unknown as ToolContext;
  try {
    expect(await callTool(ctx, policy, { id: "1", name: "flint", args: { command: "list", args: ["--unread"] } })).toEqual({ content: "ok list" });
    const sent = await callTool(ctx, policy, { id: "2", name: "flint", args: { command: "send", args: ["7"] } });
    expect(sent.content).toBe("The user declined this action. Do not try it again; ask or finish.");
    expect(asked).toEqual(["flint send 7 on Flint"]);
    const bad = await callTool(ctx, policy, { id: "3", name: "flint", args: { command: "watch" } });
    expect(bad.isError).toBe(true);
    const audit = readFileSync(join(dir.dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.map((a) => [a.site, a.action, a.result])).toEqual([["Flint", "flint", "ok"], ["Flint", "flint", "declined"]]);
  } finally {
    delete process.env.PERCH_FLINT_BIN;
  }
});
