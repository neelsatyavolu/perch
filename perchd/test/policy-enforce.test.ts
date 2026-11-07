import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { AuditLog } from "../src/agent/audit";
import { governed, runTask, type StepEvent, type TaskOptions } from "../src/agent/loop";
import type { Browser } from "../src/browser/browser";
import { connect } from "../src/cli/client";
import { ClientRegistry } from "../src/daemon/clients";
import { startDaemon, type Daemon } from "../src/daemon/daemon";
import { MemoryKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";
import { fakeModel } from "../src/models/fake";
import { fakeSource } from "../src/policy/cfprefs";
import { AGENT_OFF, CLIENTS_OFF, type PolicyValue } from "../src/policy/policy";
import { PolicyWatcher } from "../src/policy/watch";
import { emptySyncState, type SyncEngine } from "../src/sync/engine";
import { closeRelayWhenOff, managedSyncApi, SYNC_OFF } from "../src/sync/policy";
import { syncOnce, type SyncAdapter } from "../src/sync/runner";
import { tempProfile } from "./helpers";

const forced = (name: string, value: unknown): PolicyValue => ({ name, value, forced: true });

/** A watcher over values the test changes, refreshed by hand. */
function watched(initial: PolicyValue[] = []) {
  let values = initial;
  const watcher = new PolicyWatcher({ source: fakeSource(() => values), watchDir: null });
  return { watcher, set: (next: PolicyValue[]) => ((values = next), watcher.refresh()) };
}

const home = tempProfile();
const paths = perchPaths({ PERCH_HOME: home.dir });
const keychain = new MemoryKeychain();
const registry = new ClientRegistry(paths.clientsFile, keychain);
const policy = watched();
let daemon: Daemon;

beforeAll(async () => {
  daemon = await startDaemon({ paths, keychain, launch: () => Promise.reject(new Error("no browser in this test")), helloTimeoutMs: 300, confirm: async () => true, policy: policy.watcher });
});
afterAll(async () => {
  await daemon.stop();
  home.cleanup();
});

const hello = async (client: string, session: string) => ({ client, token: await registry.token(client), session, title: "perch", agent: client, persistent: false, onEnd: "close" as const });

test("MCP clients are refused when MCPServerEnabled is false", async () => {
  policy.set([forced("MCPServerEnabled", false)]);
  await expect(connect({ socket: paths.socket, hello: await hello("codex", "p1") })).rejects.toThrow(CLIENTS_OFF);
  policy.set([forced("AllowedMCPClients", ["claude-code"])]);
  await expect(connect({ socket: paths.socket, hello: await hello("codex", "p2") })).rejects.toThrow(CLIENTS_OFF);
  const ok = await connect({ socket: paths.socket, hello: await hello("claude-code", "p3") });
  ok.close();
  policy.set([]);
});

test("a connected client is closed and refused when the policy turns outside agents off", async () => {
  let closed = false;
  const c = await connect({ socket: paths.socket, hello: await hello("codex", "p4"), onClose: () => (closed = true) });
  expect((await c.request("status")) as { client: string }).toMatchObject({ client: "codex" });
  policy.set([forced("MCPServerEnabled", false)]);
  await Bun.sleep(50);
  expect(closed).toBe(true);
  policy.set([]);
});

test("a client's mode is capped, and it cannot be raised above the cap", async () => {
  await daemon.registry.verify("cli", await registry.token("cli"));
  await daemon.registry.setMode("cli", "skip");
  const c = await connect({ socket: paths.socket, hello: await hello("cli", "p5") });
  expect(((await c.request("status")) as { mode: string }).mode).toBe("skip");
  policy.set([forced("MaxPermissionMode", "guard")]);
  // The same connection: the cap applies before its next action.
  expect(((await c.request("status")) as { mode: string }).mode).toBe("guard");
  await expect(c.request("clients.mode", { name: "cli", mode: "skip" })).rejects.toThrow("Your organization allows outside agents up to guard mode.");
  await expect(daemon.registry.setMode("cli", "skip")).rejects.toThrow("up to guard mode");
  await daemon.registry.setMode("cli", "ask");
  c.close();
  policy.set([]);
});

test("ClientRegistry refuses a mode above its cap", async () => {
  const r = new ClientRegistry(join(home.dir, "other-clients.json"), new MemoryKeychain(), undefined, () => "guard");
  await r.verify("cli", await r.token("cli"));
  await expect(r.setMode("cli", "skip")).rejects.toThrow("guard");
  await r.setMode("cli", "ask");
  expect(r.find("cli").mode).toBe("ask");
});

const noBrowser = {} as Browser;
const audit = new AuditLog(join(home.dir, "audit.jsonl"));
const task = (extra: Partial<TaskOptions> = {}): TaskOptions => ({ model: fakeModel([]), browser: noBrowser, task: "t", mode: "skip", approve: async () => true, audit, ...extra });

test("agent off stops a new run with the message", async () => {
  const { watcher } = watched([forced("AgentEnabled", false)]);
  const events: StepEvent[] = [];
  for await (const event of runTask(task({ policy: watcher }))) events.push(event);
  expect(events).toEqual([{ type: "error", message: AGENT_OFF }]);
});

test("a policy change caps a running chat before its next action", () => {
  const { watcher, set } = watched();
  const opts = task({ policy: watcher, siteRule: () => "allow" });
  expect(governed(opts).mode).toBe("skip");
  set([forced("MaxPermissionMode", "guard"), forced("AgentSiteRules", [{ pattern: "bank.example", rule: "never" }])]);
  const next = governed(opts);
  expect(next.mode).toBe("guard");
  expect(next.siteRule?.("www.bank.example")).toBe("never");
  expect(next.siteRule?.("example.org")).toBe("allow");
});

test("remote control off closes the relay", () => {
  const { watcher, set } = watched();
  let closes = 0;
  closeRelayWhenOff({ close: () => closes++ }, watcher);
  watcher.current();
  set([forced("UpdateChannel", "beta")]);
  expect(closes).toBe(0);
  set([forced("RemoteControlEnabled", false)]);
  expect(closes).toBe(1);
});

test("sync is refused when off, and uses the company's server", () => {
  expect(() => managedSyncApi({ SyncEnabled: false })).toThrow(SYNC_OFF);
  expect(() => managedSyncApi({ SyncDisabled: true })).toThrow(SYNC_OFF);
  expect(managedSyncApi({ SyncServerURL: "https://sync.example.com" }).baseUrl).toBe("https://sync.example.com");
});

test("a sync pass stops before the next collection when sync turns off", async () => {
  const seen: string[] = [];
  const engine = { pull: async (state: unknown, collection: string) => (seen.push(collection), { state, items: [], unreadable: 0 }) } as unknown as SyncEngine;
  const adapter = (collection: "bookmarks" | "settings"): SyncAdapter => ({ collection, changes: async () => [], pushed: async () => undefined, apply: async () => undefined });
  let on = true;
  const run = await syncOnce(engine, emptySyncState, [adapter("bookmarks"), adapter("settings")], () => {
    const now = on;
    on = false;
    return now;
  });
  expect(seen).toEqual(["bookmarks"]);
  expect(run.stopped).toBe("policy");
});
