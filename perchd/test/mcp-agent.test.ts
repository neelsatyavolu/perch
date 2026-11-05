import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { runTask, type ApprovalRequest, type StepEvent } from "../src/agent/loop";
import type { Mode } from "../src/agent/permissions";
import type { Browser } from "../src/browser/browser";
import { mcpExtraTools, toolName, toToolResult } from "../src/mcp-client/agent-tools";
import type { LaunchRequest } from "../src/mcp-client/launch";
import { deleteServer, McpManager } from "../src/mcp-client/manager";
import { addServer, EMPTY, RegistryStore, updateServer } from "../src/mcp-client/registry";
import { storeSecrets } from "../src/mcp-client/secrets";
import { fakeModel } from "../src/models/fake";
import type { Message, TurnEvent, TurnRequest } from "../src/models/types";
import { MemoryKeychain } from "../src/secure/keychain";
import { PNG_1PX } from "./fixtures/mcp-fixture";

const SERVER = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
const FAKE = "fake-fixture-token-42";
const dir = mkdtempSync(join(tmpdir(), "perch-mcp-agent-"));
const managers: McpManager[] = [];
afterAll(async () => {
  await Promise.all(managers.map((m) => m.close()));
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
let kc: MemoryKeychain;
let store: RegistryStore;
let launches: LaunchRequest[];

beforeEach(async () => {
  kc = new MemoryKeychain();
  store = new RegistryStore(join(dir, `servers-${++n}.enc`), kc);
  launches = [];
  const config = await storeSecrets("fixture", { transport: "stdio", command: process.execPath, args: [SERVER, "--token", FAKE], env: { FIXTURE_TOKEN: FAKE } }, kc);
  await store.save(addServer(EMPTY, { name: "fixture", config, enabled: true, trusted: false, addedAt: new Date().toISOString() }));
});

function manager(approve = true): McpManager {
  const m = new McpManager({ store, keychain: kc, approveLaunch: async (r) => (launches.push(r), approve), openUrl: async () => undefined });
  managers.push(m);
  return m;
}

const tool = (name: string, args: Record<string, unknown> = {}): TurnEvent[] => [{ type: "tool_call", call: { id: `c${++n}`, name, args } }, { type: "done" }];
const say = (text: string): TurnEvent[] => [{ type: "text", delta: text }, { type: "done" }];
const lastTool = (req: TurnRequest) => [...req.messages].reverse().find((m): m is Extract<Message, { role: "tool" }> => m.role === "tool")!;
const noBrowser = {} as Browser;

async function run(m: McpManager, script: Parameters<typeof fakeModel>[0], opts: { mode?: Mode; approve?: boolean; disabled?: Set<string> } = {}) {
  const model = fakeModel(script);
  const audit = new AuditLog(join(dir, `audit-${++n}.jsonl`));
  const events: StepEvent[] = [];
  const asked: ApprovalRequest[] = [];
  const extraTools = mcpExtraTools(m, { disabled: opts.disabled });
  for await (const e of runTask({ model, browser: noBrowser, task: "Use the notes server", mode: opts.mode ?? "guard", approve: async (r) => (asked.push(r), opts.approve ?? false), audit, extraTools })) events.push(e);
  const log = () => readFileSync(audit.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { model, events, asked, log };
}

test("a stdio server asks before its first launch, with secret arguments hidden, and only once", async () => {
  const first = manager();
  expect(await first.start()).toEqual([{ name: "fixture", state: "connected", tools: 9 }]);
  expect(launches).toEqual([{ server: "fixture", transport: "stdio", command: process.execPath, args: [SERVER, "--token", "••••"], env: { FIXTURE_TOKEN: "••••" }, fromEnv: [], warnings: [] }]);
  await first.close();
  await manager().start();
  expect(launches).toHaveLength(1);
  // Changing the command asks again.
  const reg = await store.load();
  await store.save(updateServer(reg, "fixture", { config: { ...reg.servers[0]!.config, args: [SERVER, "--other"] } as never }));
  await manager().start();
  expect(launches).toHaveLength(2);
});

test("the launch request shows plain env values and flags variables that change what a program loads", async () => {
  await store.update((reg) => {
    const config = reg.servers[0]!.config;
    return updateServer(reg, "fixture", { config: { ...config, env: { ...(config.transport === "stdio" ? config.env : {}), LOG_LEVEL: "debug", NODE_OPTIONS: "--require /tmp/x.js", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", WORKDIR: "${HOME}/w" } } as never });
  });
  await manager(false).start();
  expect(launches[0]).toMatchObject({
    env: { FIXTURE_TOKEN: "••••", LOG_LEVEL: "debug", NODE_OPTIONS: "--require /tmp/x.js", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", WORKDIR: "${HOME}/w" },
    fromEnv: ["HOME"],
    warnings: ["NODE_OPTIONS changes what the program loads when it starts.", "DYLD_INSERT_LIBRARIES changes what the program loads when it starts."],
  });
});

test("a remote server asks before its first connection and names the variables it would send", async () => {
  let requests = 0;
  const fetchStub = (async () => (requests++, new Response("no", { status: 500 }))) as unknown as typeof fetch;
  const headers = await storeSecrets("remote", { transport: "http", url: "https://mcp.example.test/mcp?team=${TEAM_ID}", headers: { Authorization: "Bearer ${OPENAI_API_KEY}", "X-Plain": "${OTHER}" } }, kc);
  await store.save(addServer(EMPTY, { name: "remote", config: headers, enabled: true, trusted: false, addedAt: "x" }));
  const m = new McpManager({ store, keychain: kc, approveLaunch: async (r) => (launches.push(r), false), openUrl: async () => undefined, fetch: fetchStub, env: { OPENAI_API_KEY: "sk-fake" } });
  managers.push(m);
  expect(await m.start()).toEqual([{ name: "remote", state: "declined", tools: 0, error: "You did not allow this server to run." }]);
  expect(requests).toBe(0);
  expect(launches).toEqual([{
    server: "remote",
    transport: "http",
    url: "https://mcp.example.test/mcp?team=${TEAM_ID}",
    headers: ["Authorization", "X-Plain"],
    fromEnv: ["TEAM_ID", "OPENAI_API_KEY", "OTHER"],
    warnings: ["Perch would send values from its environment to this server: TEAM_ID, OPENAI_API_KEY, OTHER."],
  }]);
  expect(JSON.stringify(launches)).not.toContain("sk-fake");
});

test("declining the launch leaves the server off with a plain status", async () => {
  expect(await manager(false).start()).toEqual([{ name: "fixture", state: "declined", tools: 0, error: "You did not allow this server to run." }]);
});

test("secrets reach the server from the Keychain", async () => {
  const m = manager();
  await m.start();
  expect((await m.call("fixture", "env_value", { name: "FIXTURE_TOKEN" })).content[0]).toEqual({ type: "text", text: FAKE });
});

test("Guard mode: read-only tools run, other tools wait for approval; everything is audited", async () => {
  const m = manager();
  await m.start();
  const { model, events, asked, log } = await run(m, [
    () => tool(toolName("fixture", "echo"), { text: "hello" }),
    (req) => (expect(lastTool(req).content).toBe("hello"), tool(toolName("fixture", "add_note"), { note: "buy milk" })),
    (req) => say(lastTool(req).content),
  ]);
  expect(model.requests[0]!.tools.map((t) => t.name)).toContain("mcp__fixture__echo");
  expect(model.requests[0]!.system).toContain("mcp__<server>__<tool>");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ kind: "risky", site: "mcp:fixture", summary: 'Use add_note on the fixture MCP server with {"note":"buy milk"}' });
  expect(events.at(-1)).toEqual({ type: "final", text: "The user declined this action. Do not try it again; ask or finish." });
  expect(events.filter((e) => e.type === "step")).toEqual([{ type: "step", label: "Used echo (fixture)" }]);
  expect(log().map((l) => [l.action, l.approved, l.result, l.site])).toEqual([
    ["mcp__fixture__echo", null, "ok", "mcp:fixture"],
    ["mcp__fixture__add_note", false, "declined", "mcp:fixture"],
  ]);
});

test("approving runs the tool", async () => {
  const m = manager();
  await m.start();
  const { events, log } = await run(m, [() => tool("mcp__fixture__add_note", { note: "x" }), (req) => say(lastTool(req).content)], { approve: true });
  expect(events.at(-1)).toEqual({ type: "final", text: "saved (1 notes)" });
  expect(log().at(-1)).toMatchObject({ approved: true, result: "ok" });
});

test("a trusted server's tools run in Guard, still ask in Ask mode, and destructive tools always ask outside Skip", async () => {
  await store.save(updateServer(await store.load(), "fixture", { trusted: true }));
  const m = manager();
  await m.start();
  const guard = await run(m, [() => tool("mcp__fixture__add_note", { note: "a" }), () => tool("mcp__fixture__delete_all"), (req) => say(lastTool(req).content)]);
  expect(guard.asked.map((a) => [a.call.name, a.kind])).toEqual([["mcp__fixture__delete_all", "risky"]]);
  const ask = await run(m, [() => tool("mcp__fixture__add_note", { note: "a" }), (req) => say(lastTool(req).content)], { mode: "ask" });
  expect(ask.asked.map((a) => a.kind)).toEqual(["change"]);
  const ro = await run(m, [() => tool("mcp__fixture__echo", { text: "r" }), (req) => say(lastTool(req).content)], { mode: "ask" });
  expect(ro.asked).toHaveLength(0);
  const skip = await run(m, [() => tool("mcp__fixture__delete_all"), (req) => say(lastTool(req).content)], { mode: "skip" });
  expect(skip.asked).toHaveLength(0);
  expect(skip.events.at(-1)).toEqual({ type: "final", text: "deleted" });
});

test("bad arguments and tool errors come back to the model; a server switched off for the chat is hidden", async () => {
  const m = manager();
  await m.start();
  const bad = await run(m, [() => tool("mcp__fixture__echo", {}), (req) => say(lastTool(req).content)]);
  expect(bad.events.at(-1)).toEqual({ type: "final", text: 'missing argument "text"' });
  const broken = await run(m, [() => tool("mcp__fixture__broken"), (req) => say(lastTool(req).content)]);
  expect(broken.events.at(-1)).toEqual({ type: "final", text: "the tool failed on purpose" });
  const off = await run(m, [(req) => say(String(req.tools.some((t) => t.name.startsWith("mcp__"))))], { disabled: new Set(["fixture"]) });
  expect(off.events.at(-1)).toEqual({ type: "final", text: "false" });
});

test("a server that went away is reconnected on the next call", async () => {
  const m = manager();
  await m.start();
  await m.disconnect("fixture");
  expect((await m.call("fixture", "echo", { text: "back" })).content[0]).toEqual({ type: "text", text: "back" });
});

test("results: PNG images are described, not sent; long output is cut", () => {
  expect(toToolResult({ content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }], isError: false }).content).toMatch(/^\[image\/png image, \d+ bytes, not shown\]$/);
  expect(toToolResult({ content: [{ type: "image", data: "abcd", mimeType: "image/jpeg" }], isError: false })).toEqual({ content: "(no output)", image: "abcd" });
  expect(toToolResult({ content: [{ type: "text", text: "x".repeat(30_000) }], isError: false }).content).toEndWith("(30,000 characters, cut)");
  expect(toToolResult({ content: [], structuredContent: { a: 1 }, isError: false }).content).toBe('{"a":1}');
});

test("removing a server deletes its Keychain items", async () => {
  expect(kc.accounts().filter((a) => a.startsWith("mcp/"))).toHaveLength(2);
  await deleteServer(store, kc, "fixture");
  expect(kc.accounts().filter((a) => a.startsWith("mcp/"))).toEqual([]);
  expect((await store.load()).servers).toEqual([]);
});
