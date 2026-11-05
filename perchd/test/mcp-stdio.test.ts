import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { McpClient } from "../src/mcp-client/client";
import { childEnv, StdioTransport } from "../src/mcp-client/stdio";

const SERVER = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
const FAKE = "fake-secret-for-stdio-test";
const transport = (extra: string[] = [], env: Record<string, string> = {}) => new StdioTransport({ command: process.execPath, args: [SERVER, ...extra], env });

let client: McpClient;
beforeAll(async () => {
  client = await McpClient.connect(transport([], { FIXTURE_TOKEN: FAKE }));
});
afterAll(() => client.close());

test("connects, skips a stdout banner and lists every page of tools", async () => {
  expect(client.serverInfo.name).toBe("fixture");
  expect(client.instructions).toBe("Fixture server.");
  const tools = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(["echo", "add_note", "delete_all", "slow", "env_value", "picture", "broken", "grow", "big"]);
  expect(tools[0]!.annotations.readOnlyHint).toBe(true);
  expect(tools[1]!.annotations.readOnlyHint).toBeUndefined();
});

test("calls a tool, and passes the server's own env", async () => {
  expect(await client.callTool("echo", { text: "hi" })).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
  const env = await client.callTool("env_value", { name: "FIXTURE_TOKEN" });
  expect(env.content[0]).toEqual({ type: "text", text: FAKE });
});

test("an unknown tool is a JSON-RPC error with the server's message", async () => {
  await expect(client.callTool("nope", {})).rejects.toThrow("unknown tool nope");
});

test("a slow call times out or is cancelled, and the connection keeps working", async () => {
  await expect(client.callTool("slow", { ms: 2000 }, { timeoutMs: 100 })).rejects.toThrow("did not answer tools/call within");
  const ac = new AbortController();
  const pending = client.callTool("slow", { ms: 2000 }, { signal: ac.signal });
  ac.abort();
  await expect(pending).rejects.toThrow("Cancelled.");
  expect((await client.callTool("echo", { text: "still here" })).content[0]).toEqual({ type: "text", text: "still here" });
});

test("tools/list_changed reaches the client", async () => {
  let changed = 0;
  client.onToolsChanged(() => changed++);
  await client.callTool("grow", {});
  await Bun.sleep(20);
  expect(changed).toBe(1);
  expect((await client.listTools()).map((t) => t.name)).toContain("extra");
});

test("a server that exits during start-up gives a plain error", async () => {
  await expect(McpClient.connect(transport(["--crash"]))).rejects.toThrow(/exited \(code 3\): fixture stderr line/);
});

test("a missing command gives a plain error", async () => {
  const t = new StdioTransport({ command: "perch-no-such-command-xyz", args: [], env: {} });
  await expect(McpClient.connect(t)).rejects.toThrow('Could not start "perch-no-such-command-xyz"');
});

test("the child environment drops secret-looking variables and adds install folders to PATH", () => {
  const env = childEnv({ HOME: "/Users/u", PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: FAKE, GITHUB_TOKEN: FAKE, LANG: "en_US.UTF-8" }, { OWN_TOKEN: "own" });
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.OWN_TOKEN).toBe("own");
  expect(env.LANG).toBe("en_US.UTF-8");
  expect(env.PATH!.split(":")).toEqual(expect.arrayContaining(["/usr/bin", "/opt/homebrew/bin", "/Users/u/.bun/bin"]));
});
