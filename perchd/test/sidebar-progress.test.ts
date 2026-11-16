import { afterAll, beforeAll, expect, test } from "bun:test";
import { FAILING, Progress } from "../src/agent/progress";
import { SidebarRuns } from "../src/app/sidebar-runner";
import { Browser } from "../src/browser/browser";
import { connect } from "../src/cli/client";
import { startDaemon, type Daemon } from "../src/daemon/daemon";
import { MemoryKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";
import { SIDEBAR_CLIENT } from "../src/daemon/server";
import { tempProfile } from "./helpers";

const TOKEN = "p".repeat(43);
const home = tempProfile();
const profile = tempProfile();
const paths = perchPaths({ PERCH_HOME: home.dir });
const runs = new SidebarRuns();
let daemon: Daemon;
let browser: Browser;

beforeAll(async () => {
  browser = await Browser.launch({ userDataDir: profile.dir });
  daemon = await startDaemon({ paths, keychain: new MemoryKeychain(), launch: async () => browser, sidebar: (s) => runs.get(s), helloTimeoutMs: 2000 });
});
afterAll(async () => {
  await daemon.stop();
  home.cleanup();
  profile.cleanup();
});

test("a sidebar run's tool results carry the stuck notes Perch's own loop gets", async () => {
  runs.add("sidebar-stuck", { token: TOKEN, mode: "skip", approve: async () => true, progress: new Progress({}) });
  const client = await connect({ socket: paths.socket, hello: { client: SIDEBAR_CLIENT, token: TOKEN, session: "sidebar-stuck", title: "Sidebar", agent: "Perch", persistent: true, onEnd: "close" } });
  const click = (ref: string) => client.request<{ content: string; isError?: boolean }>("call", { name: "click", args: { ref } });
  expect((await click("e997")).content).not.toContain(FAILING);
  await click("e998");
  const third = await click("e999");
  expect(third.content).toStartWith(FAILING);
  expect(third.isError).toBe(true);
  await client.request("end", { onEnd: "close" });
  client.close();
  runs.delete("sidebar-stuck");
}, 30_000);
