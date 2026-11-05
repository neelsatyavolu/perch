import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { connect, DaemonNotRunning } from "../src/cli/client";
import { Browser } from "../src/browser/browser";
import { ClientRegistry } from "../src/daemon/clients";
import { startDaemon, type Daemon } from "../src/daemon/daemon";
import { MemoryKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";
import { startFixtures } from "./fixtures/server";
import { tempProfile } from "./helpers";

const home = tempProfile();
const profile = tempProfile();
const site = startFixtures();
const paths = perchPaths({ PERCH_HOME: home.dir });
const keychain = new MemoryKeychain();
const registry = new ClientRegistry(paths.clientsFile, keychain);
let daemon: Daemon;

beforeAll(async () => {
  daemon = await startDaemon({ paths, keychain, launch: () => Browser.launch({ userDataDir: profile.dir }), graceMs: 100, helloTimeoutMs: 300 });
});
afterAll(async () => {
  await daemon.stop();
  site.stop();
  home.cleanup();
  profile.cleanup();
});

const hello = async (client: string, session: string, extra: object = {}) => ({
  client,
  token: await registry.token(client),
  session,
  title: "perch",
  agent: client,
  persistent: false,
  onEnd: "close" as const,
  ...extra,
});

test("the socket is private to the user and a second daemon refuses to start", async () => {
  expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
  expect(statSync(paths.runDir).mode & 0o777).toBe(0o700);
  await expect(startDaemon({ paths, keychain, launch: () => Promise.reject(new Error("unused")) })).rejects.toThrow("perchd is already running");
  await expect(connect({ socket: join(home.dir, "nope.sock"), hello: await hello("cli", "x") })).rejects.toBeInstanceOf(DaemonNotRunning);
});

test("a wrong token, a revoked client and a silent client are turned away", async () => {
  await expect(connect({ socket: paths.socket, hello: { ...(await hello("cli", "x")), token: "A".repeat(43) } })).rejects.toThrow("Perch did not accept this client's token.");
  await registry.token("grok");
  await registry.revoke("grok");
  await expect(connect({ socket: paths.socket, hello: await hello("grok", "x") })).rejects.toThrow('Client "grok" was revoked.');

  const silent = await new Promise<string>((resolve) => {
    let got = "";
    void Bun.connect({ unix: paths.socket, socket: { data: (_s, d) => void (got += new TextDecoder().decode(d)), close: () => resolve(got) } });
  });
  expect(JSON.parse(silent)).toEqual({ type: "error", error: "No hello in time." });
  const audit = readFileSync(paths.auditFile, "utf8");
  expect(audit).toContain('"action":"connect"');
  expect(audit).not.toContain("A".repeat(43));
});

test("a client works in its own session with the same tools as the MCP server", async () => {
  const c = await connect({ socket: paths.socket, hello: await hello("claude-code", "t1", { agent: "claude-code", title: "Fix login", persistent: true }) });
  expect(c.welcome).toMatchObject({ client: "claude-code", session: "t1", label: "Claude Code · Fix login", mode: "guard" });
  const tools = await c.request<{ name: string }[]>("tools");
  expect(tools.map((t) => t.name)).toContain("snapshot");
  expect(tools.map((t) => t.name)).not.toContain("done");
  const page = await c.request<{ content: string }>("call", { name: "navigate", args: { url: site.url("/mail.html") } });
  expect(page.content).toContain('button "Compose"');
  await expect(c.request("nope")).rejects.toThrow('Unknown method "nope".');
  await expect(c.request("clients.list")).rejects.toThrow("Only the perch command can change clients.");
  const status = await c.request<{ sessions: { label: string; tabs: number }[] }>("status");
  expect(status.sessions).toContainEqual(expect.objectContaining({ label: "Claude Code · Fix login", tabs: 1 }));

  c.close();
  await Bun.sleep(500);
  expect(daemon.manager.get("claude-code", "t1")).toBeUndefined();
}, 30_000);

test("risky actions ask an interactive client and are declined for others", async () => {
  const asks: string[] = [];
  const yes = await connect({ socket: paths.socket, hello: await hello("cli", "a1"), onApprove: async (ask) => (asks.push(ask.summary), true) });
  const page = await yes.request<{ content: string }>("call", { name: "navigate", args: { url: site.url("/mail.html") } });
  const compose = page.content.match(/button "Compose" \[ref=(e\d+)\]/)![1];
  const full = await yes.request<{ content: string }>("call", { name: "click", args: { ref: compose } });
  const ref = full.content.match(/button "Send" \[ref=(e\d+)\]/)![1];
  const sent = await yes.request<{ content: string; isError?: boolean }>("call", { name: "click", args: { ref } });
  expect(sent.isError).toBeFalsy();
  expect(asks[0]).toContain('Click button "Send"');

  const no = await connect({ socket: paths.socket, hello: await hello("cli", "a2") });
  await no.request("call", { name: "navigate", args: { url: site.url("/far.html") } });
  const again = await no.request<{ content: string }>("call", { name: "snapshot", args: { full: true } });
  const ref2 = again.content.match(/button "Send" \[ref=(e\d+)\]/)![1];
  const declined = await no.request<{ content: string }>("call", { name: "click", args: { ref: ref2 } });
  expect(declined.content).toBe("The user declined this action. Do not try it again; ask or finish.");

  const clients = await no.request<{ name: string; mode: string }[]>("clients.mode", { name: "claude-code", mode: "ask" });
  expect(clients.find((x) => x.name === "claude-code")?.mode).toBe("ask");
  yes.close();
  no.close();
}, 30_000);
