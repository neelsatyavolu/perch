import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect } from "../src/cli/client";
import { Browser } from "../src/browser/browser";
import { ClientRegistry } from "../src/daemon/clients";
import { startDaemon, type Daemon } from "../src/daemon/daemon";
import { MemoryKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";
import type { ApprovalRequest } from "../src/agent/session";
import { startFixtures } from "./fixtures/server";
import { tempProfile } from "./helpers";

const home = tempProfile();
const profile = tempProfile();
const site = startFixtures();
const paths = perchPaths({ PERCH_HOME: home.dir });
const keychain = new MemoryKeychain();
const registry = new ClientRegistry(paths.clientsFile, keychain);
const allowAsks: string[] = [];
const approveAsks: { label: string; request: ApprovalRequest }[] = [];
let allow = false;
let daemon: Daemon;

beforeAll(async () => {
  daemon = await startDaemon({
    paths,
    keychain,
    launch: () => Browser.launch({ userDataDir: profile.dir }),
    helloTimeoutMs: 300,
    confirm: async () => false,
    browser: () => ({
      allowClient: async (name) => {
        allowAsks.push(name);
        // Longer than the hello timeout: a card waiting on the user must not time the client out.
        await Bun.sleep(500);
        return allow;
      },
      approve: async (session, request) => (approveAsks.push({ label: session.label, request }), true),
    }),
  });
});
afterAll(async () => {
  await daemon.stop();
  site.stop();
  home.cleanup();
  profile.cleanup();
});

const hello = async (client: string, session: string) => ({
  client, token: await registry.token(client), session, title: "perch", agent: client, persistent: false, onEnd: "close" as const,
});

test("a new client's first connection waits for the browser card; declined, nothing is recorded", async () => {
  allow = false;
  await expect(connect({ socket: paths.socket, hello: await hello("codex", "n1") })).rejects.toThrow(`You didn't allow "codex" to use Perch`);
  expect(daemon.registry.list().some((c) => c.name === "codex")).toBe(false);
  allow = true;
  const c = await connect({ socket: paths.socket, hello: await hello("codex", "n2") });
  expect(c.welcome).toMatchObject({ client: "codex", mode: "guard" });
  expect(allowAsks).toEqual(["codex", "codex"]);
  c.close();
  // Known now: no second card.
  const again = await connect({ socket: paths.socket, hello: await hello("codex", "n3") });
  expect(allowAsks.length).toBe(2);
  again.close();
});

test("a client without its own prompt gets risky actions approved through the browser", async () => {
  allow = true;
  const c = await connect({ socket: paths.socket, hello: await hello("codex", "a1") });
  await c.request("call", { name: "navigate", args: { url: site.url("/far.html") } });
  const page = await c.request<{ content: string }>("call", { name: "snapshot", args: { full: true } });
  const ref = page.content.match(/button "Send" \[ref=(e\d+)\]/)![1];
  const sent = await c.request<{ content: string; isError?: boolean }>("call", { name: "click", args: { ref } });
  expect(sent.isError).toBeFalsy();
  expect(approveAsks.length).toBe(1);
  expect(approveAsks[0]!.request.summary).toContain('Click button "Send"');
  c.close();
}, 30_000);
