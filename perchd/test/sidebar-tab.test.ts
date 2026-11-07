import { afterAll, beforeAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { SidebarRuns } from "../src/app/sidebar-runner";
import { Browser } from "../src/browser/browser";
import { connectStreams } from "../src/cdp/adopt";
import { encode } from "../src/cdp/pipe";
import { connect } from "../src/cli/client";
import { startDaemon, type Daemon } from "../src/daemon/daemon";
import { MemoryKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";
import { SIDEBAR_CLIENT } from "../src/daemon/server";
import { tempProfile } from "./helpers";

const TOKEN = "s".repeat(43);

/** A browser end that answers like Perch: it has the Perch domain and records what it was sent. */
function fakePerch(perch: boolean) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  toBrowser.on("data", (chunk: Buffer) => {
    for (const part of chunk.toString().split("\0").filter(Boolean)) {
      const msg = JSON.parse(part) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      sent.push({ method: msg.method, params: msg.params });
      const reply = (result: unknown) => fromBrowser.write(encode({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result }));
      if (msg.method.startsWith("Perch.") && !perch) fromBrowser.write(encode({ id: msg.id, error: { code: -32601, message: `'${msg.method}' wasn't found` } }));
      else if (msg.method === "Perch.getInfo") reply({ product: "Perch/158", perch: true });
      else if (msg.method === "Target.createTarget") reply({ targetId: "AGENT1" });
      else if (msg.method === "Target.attachToTarget") reply({ sessionId: "S1" });
      else if (msg.method === "Page.getFrameTree") reply({ frameTree: { frame: { id: "F1" } } });
      else reply({});
    }
  });
  return { conn: connectStreams(toBrowser, fromBrowser), sent };
}

test("inside Perch, agent tabs open in the user's window and are held drawing", async () => {
  const { conn, sent } = fakePerch(true);
  const browser = await Browser.adopt(conn);
  expect(browser.perch).toBe(true);
  await browser.newTab();
  const create = sent.find((m) => m.method === "Target.createTarget")!;
  expect(create.params).toEqual({ url: "about:blank", background: true });
  expect(sent.find((m) => m.method === "Perch.claimTab")?.params).toEqual({ targetId: "AGENT1" });
  conn.close();
});

test("in a plain Chromium, agent tabs still get a window of their own", async () => {
  const { conn, sent } = fakePerch(false);
  const browser = await Browser.adopt(conn);
  expect(browser.perch).toBe(false);
  await browser.newTab();
  expect(sent.find((m) => m.method === "Target.createTarget")?.params).toMatchObject({ newWindow: true });
  expect(sent.some((m) => m.method === "Perch.claimTab")).toBe(false);
  conn.close();
});

const home = tempProfile();
const profile = tempProfile();
const paths = perchPaths({ PERCH_HOME: home.dir });
const runs = new SidebarRuns();
let daemon: Daemon;
let browser: Browser;
const site = Bun.serve({ port: 0, fetch: () => new Response("<title>Cart</title><h1>Two items</h1>", { headers: { "content-type": "text/html" } }) });

beforeAll(async () => {
  browser = await Browser.launch({ userDataDir: profile.dir });
  daemon = await startDaemon({
    paths,
    keychain: new MemoryKeychain(),
    launch: async () => browser,
    sidebar: (s) => runs.get(s),
    helloTimeoutMs: 2000,
  });
});
afterAll(async () => {
  await daemon.stop();
  site.stop(true);
  home.cleanup();
  profile.cleanup();
});

const hello = (session: string) => ({ client: SIDEBAR_CLIENT, token: TOKEN, session, title: "Sidebar", agent: "Perch", persistent: true, onEnd: "close" as const });

test("a sidebar task on the current tab starts in that tab and gives it back when it ends", async () => {
  // The user's tab: opened by the browser, not by any agent.
  const { targetId: userTab } = await browser.conn.send<{ targetId: string }>("Target.createTarget", { url: `http://127.0.0.1:${site.port}/cart` });
  await Bun.sleep(300);

  runs.add("sidebar-cart", { token: TOKEN, mode: "skip", approve: async () => true, tab: userTab });
  const client = await connect({ socket: paths.socket, hello: hello("sidebar-cart") });
  const tabs = await client.request<string>("tabs");
  expect(tabs).toContain(`* ${userTab} Cart`);
  expect(tabs.split("\n").find((l) => l.includes(userTab))).toContain("(yours)");
  const page = await client.request<{ content: string }>("call", { name: "snapshot", args: {} });
  expect(page.content).toContain("Two items");
  await client.request("end", { onEnd: "close" });
  expect((await browser.tabs()).some((t) => t.id === userTab)).toBe(true);
  client.close();
  runs.delete("sidebar-cart");
});
