import { afterAll, beforeAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { connectStreams } from "../src/cdp/adopt";
import { encode } from "../src/cdp/pipe";
import { startApp } from "../src/app/app";
import { memoryKeychain } from "../src/app/keychain";
import { SidebarRuns, stepLabel } from "../src/app/sidebar-runner";
import { Vault } from "../src/app/vault";
import { connect } from "../src/cli/client";
import { parseBrowserSettings, perchCommand } from "../src/cli/serve-browser";
import { startDaemon, type Daemon } from "../src/daemon/daemon";
import { MemoryKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";
import { SIDEBAR_CLIENT } from "../src/daemon/server";
import { codexArgs, tomlTable } from "../src/external";
import { tempProfile } from "./helpers";

const TOKEN = "t".repeat(43);

test("the browser's settings line is checked before perchd uses it", () => {
  const good = { op: "app", port: 50123, token: TOKEN, browserToken: "b".repeat(43), dataDir: "/Users/x/Library/Application Support/Perch", origins: ["chrome-untrusted://perch-side-chat.top-chrome", "https://evil.test"] };
  expect(parseBrowserSettings(JSON.stringify(good))).toEqual({ port: 50123, token: TOKEN, browserToken: "b".repeat(43), dataDir: good.dataDir, origins: ["chrome-untrusted://perch-side-chat.top-chrome"] });
  expect(() => parseBrowserSettings(JSON.stringify({ ...good, browserToken: TOKEN }))).toThrow("bad browser token");
  expect(() => parseBrowserSettings(JSON.stringify({ ...good, browserToken: undefined }))).toThrow("bad browser token");
  expect(() => parseBrowserSettings(JSON.stringify({ ...good, port: 0 }))).toThrow("bad port");
  expect(() => parseBrowserSettings(JSON.stringify({ ...good, token: "short" }))).toThrow("bad token");
  expect(() => parseBrowserSettings(JSON.stringify({ ...good, dataDir: "relative" }))).toThrow("bad data folder");
  expect(() => parseBrowserSettings(JSON.stringify({ ...good, op: "key" }))).toThrow("bad port");
});

test("perch mcp is started from the compiled binary, or through bun in development", () => {
  expect(perchCommand("/Applications/Perch.app/Contents/Frameworks/x/Helpers/perchd", "/$bunfs/root")).toEqual({ command: "/Applications/Perch.app/Contents/Frameworks/x/Helpers/perchd", args: [] });
  expect(perchCommand("/opt/homebrew/bin/bun", "/repo/perchd/src/cli")).toEqual({ command: "/opt/homebrew/bin/bun", args: ["run", "/repo/perchd/src/cli/main.ts"] });
});

test("sidebar steps read as short actions", () => {
  expect(stepLabel("navigate", { url: "https://www.example.com/a?b=1" })).toBe("Open www.example.com");
  expect(stepLabel("navigate", { url: "example.com" })).toBe("Open example.com");
  expect(stepLabel("click", { ref: "e12" })).toBe("Click");
  expect(stepLabel("type", { ref: "e3", text: "secret words" })).toBe("Type");
  expect(stepLabel("wait_for", {})).toBe("Wait");
  expect(stepLabel("wait_for", { text: "Results" })).toBe('Wait for "Results"');
  expect(stepLabel("press", { key: "Enter" })).toBe("Press Enter");
  expect(stepLabel("snapshot", {})).toBe("Read the page");
});

test("Codex gets the sidebar's MCP server with its session in the environment", () => {
  expect(tomlTable({ PERCH_SESSION: "sidebar-1", PERCH_TOKEN: 'a"b' })).toBe('{PERCH_SESSION="sidebar-1",PERCH_TOKEN="a\\"b"}');
  expect(() => tomlTable({ "bad key": "x" })).toThrow();
  const args = codexArgs({ mcpArgs: ["mcp"], command: "/x/perchd", env: { PERCH_SESSION: "s" }, prompt: "p", otherServers: [] });
  expect(args).toContain('mcp_servers.perch.command="/x/perchd"');
  expect(args).toContain('mcp_servers.perch.env={PERCH_SESSION="s"}');
});

test("CDP over inherited streams: requests go out framed and replies come back", async () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const conn = connectStreams(toBrowser, fromBrowser);
  const sent: unknown[] = [];
  toBrowser.on("data", (chunk: Buffer) => {
    for (const part of chunk.toString().split("\0").filter(Boolean)) {
      const msg = JSON.parse(part) as { id: number; method: string };
      sent.push(msg.method);
      fromBrowser.write(encode({ id: msg.id, result: { product: "Perch/158" } }));
    }
  });
  expect(await conn.send<{ product: string }>("Browser.getVersion")).toEqual({ product: "Perch/158" });
  expect(sent).toEqual(["Browser.getVersion"]);
  fromBrowser.end();
  expect(await conn.closed).toBeInstanceOf(Error);
});

const home = tempProfile();
const paths = perchPaths({ PERCH_HOME: home.dir });
const runs = new SidebarRuns();
let daemon: Daemon;

beforeAll(async () => {
  daemon = await startDaemon({ paths, keychain: new MemoryKeychain(), launch: () => Promise.reject(new Error("unused")), sidebar: (s) => runs.get(s), helloTimeoutMs: 300 });
});
afterAll(async () => {
  await daemon.stop();
  home.cleanup();
});

const sidebarHello = (session: string, token: string) => ({ client: SIDEBAR_CLIENT, token, session, title: "Sidebar", agent: "Perch", persistent: true, onEnd: "close" as const });

test("a sidebar run's agent connects with its one-off token and gets the chat's mode", async () => {
  runs.add("sidebar-abc", { token: TOKEN, mode: "skip", approve: async () => true });
  const client = await connect({ socket: paths.socket, hello: sidebarHello("sidebar-abc", TOKEN) });
  expect(client.welcome.mode).toBe("skip");
  client.close();
  await expect(connect({ socket: paths.socket, hello: sidebarHello("sidebar-abc", "u".repeat(43)) })).rejects.toThrow("Perch did not accept this client's token.");
  await expect(connect({ socket: paths.socket, hello: sidebarHello("sidebar-other", TOKEN) })).rejects.toThrow("Perch did not accept this client's token.");
  runs.delete("sidebar-abc");
  await expect(connect({ socket: paths.socket, hello: sidebarHello("sidebar-abc", TOKEN) })).rejects.toThrow("Perch did not accept this client's token.");
});

test("inside Perch only the browser reports tabs, and its token does nothing else", async () => {
  const dir = tempProfile();
  const app = await startApp({ dataDir: dir.dir, vault: await Vault.open(memoryKeychain(), "Default"), runner: async function* () {}, models: [], allowedOrigins: [], token: TOKEN, browserToken: "b".repeat(43) });
  const call = (token: string, method: string, path: string, json?: unknown) =>
    fetch(`${app.server.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
  const report = { windowId: "w1", title: "Bank", url: "https://bank.example", targetId: "T1" };
  expect((await call(TOKEN, "PATCH", "/api/tabs/t1", report)).status).toBe(403);
  expect((await call(TOKEN, "PUT", "/api/tabs", { tabs: [] })).status).toBe(403);
  expect((await call(TOKEN, "POST", "/api/windows/w1/active", { tab: { id: "t1" } })).status).toBe(403);
  expect((await call("b".repeat(43), "PATCH", "/api/tabs/t1", report)).status).toBe(200);
  expect((await call("b".repeat(43), "GET", "/api/windows/w1")).status).toBe(403);
  expect((await call("b".repeat(43), "GET", "/api/chats")).status).toBe(403);
  expect((await call(TOKEN, "GET", "/api/windows/w1")).status).toBe(200);
  await app.stop();
  dir.cleanup();
});

test("a sidebar agent gets the run's skills and memory beside the browser tools, under the chat's approvals", async () => {
  const asked: string[] = [];
  const ran: string[] = [];
  const extras = {
    specs: () => [{ name: "load_skill", description: "Read a skill", parameters: { type: "object", properties: {} } }, { name: "memory_save", description: "Save", parameters: { type: "object", properties: {} } }],
    prompt: () => "Skills: amazon",
    handles: (name: string) => name === "load_skill" || name === "memory_save",
    check: () => null,
    describe: (call: { name: string }) => ({ kind: call.name === "load_skill" ? ("read" as const) : ("change" as const), site: "skills", summary: `Use ${call.name}`, detail: call.name, label: call.name }),
    run: async (call: { name: string }) => (ran.push(call.name), { content: `${call.name} ok` }),
    mustAsk: (call: { name: string; args: Record<string, unknown> }) => call.name === "memory_save" && call.args.category === "user",
  };
  runs.add("sidebar-extras", { token: TOKEN, mode: "skip", approve: async (r) => (asked.push(r.summary), false), extras });
  const client = await connect({ socket: paths.socket, hello: sidebarHello("sidebar-extras", TOKEN) });
  const tools = await client.request<{ name: string }[]>("tools");
  expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["click", "navigate", "load_skill", "memory_save"]));
  expect(await client.request<{ content: string }>("call", { name: "load_skill", args: { name: "amazon" } })).toEqual({ content: "load_skill ok" });
  // Skip mode runs an ordinary save; one that must ask goes to the card, and a decline stops it.
  expect(await client.request<{ content: string }>("call", { name: "memory_save", args: { category: "places" } })).toEqual({ content: "memory_save ok" });
  const declined = await client.request<{ isError?: boolean }>("call", { name: "memory_save", args: { category: "user" } });
  expect(declined.isError).toBe(true);
  expect(asked).toEqual(["Use memory_save"]);
  expect(ran).toEqual(["load_skill", "memory_save"]);
  client.close();
  runs.delete("sidebar-extras");
  // Another client never sees them.
});
