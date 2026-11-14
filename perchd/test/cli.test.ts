import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CliIO } from "../src/cli/main";
import { defaultClient, defaultSession } from "../src/cli/io";
import { Browser } from "../src/browser/browser";
import { startDaemon, type Daemon } from "../src/daemon/daemon";
import { MemoryKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";
import { startFixtures } from "./fixtures/server";
import { tempProfile } from "./helpers";

const home = tempProfile();
const profile = tempProfile();
const site = startFixtures();
const keychain = new MemoryKeychain();
let daemon: Daemon;

beforeAll(async () => {
  daemon = await startDaemon({ paths: perchPaths({ PERCH_HOME: home.dir }), keychain, launch: () => Browser.launch({ userDataDir: profile.dir }), confirm: async () => true });
});
afterAll(async () => {
  await daemon.stop();
  site.stop();
  home.cleanup();
  profile.cleanup();
});

async function perch(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIO = {
    env: { PERCH_HOME: home.dir, HOME: home.dir },
    cwd: "/Users/someone/projects/perch",
    keychain,
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    autostart: false,
  };
  const code = await main(argv, io);
  return { code, out, err };
}

test("open, tabs, snapshot, click and screenshot work in the terminal's own session", async () => {
  const opened = await perch("open", site.url("/mail.html"));
  expect(opened.code).toBe(0);
  expect(opened.out).toContain('button "Compose"');

  const tabs = await perch("tabs");
  expect(tabs.out).toMatch(/^\* [A-F0-9]{32} Mailroom · .*mail\.html \(yours\)$/m);

  const snap = await perch("snapshot");
  const ref = snap.out.match(/button "Compose" \[ref=(e\d+)\]/)![1]!;
  const clicked = await perch("click", ref);
  expect(clicked.code).toBe(0);
  expect(clicked.out).toContain('button "Send"');

  const file = join(home.dir, "shot.jpg");
  const shot = await perch("screenshot", "-o", file);
  expect(shot.out.trim()).toBe(`Saved ${file}`);
  expect([...readFileSync(file).subarray(0, 2)]).toEqual([0xff, 0xd8]);

  const evaluated = await perch("eval", "document.title");
  expect(evaluated.out.trim()).toBe('"Mailroom"');
  // The REPL keeps its variables from one command to the next.
  await perch("repl", "const n1 = 40");
  const repl = await perch("repl", "log(n1 + 2, typeof listBrowserTabs)");
  expect(repl.out.trim()).toBe("42 function");

  const status = JSON.parse((await perch("status", "--json")).out);
  expect(status).toMatchObject({ client: "cli", mode: "guard", session: "default", label: "Terminal · perch" });

  const sessions = await perch("sessions");
  expect(sessions.out).toContain("Terminal · perch  1 tab");

  expect((await perch("session", "end")).code).toBe(0);
  expect((await perch("sessions")).out).toContain("No agent sessions.");
}, 60_000);

test("separate --session names keep separate tab groups", async () => {
  await perch("open", "--session", "research", site.url("/news.html"));
  const listed = await perch("sessions", "--json");
  expect(JSON.parse(listed.out)).toContainEqual(expect.objectContaining({ session: "research", tabs: 1 }));
  const focus = await perch("focus", "--session", "research");
  expect(focus.code).toBe(0);
  const missing = await perch("focus", "--client", "agterm", "--session", "T1");
  expect(missing).toMatchObject({ code: 1, err: 'No session "T1" for agterm.\n' });
}, 60_000);

test("errors, usage and admin commands", async () => {
  expect(await perch("click", "x1")).toMatchObject({ code: 1, err: 'ref "x1" is not a valid ref; refs look like e12\n' });
  expect((await perch("bogus")).code).toBe(64);
  expect((await perch("type", "e1")).err).toContain("usage: perch type <ref> <text>");
  expect((await perch("guide")).out).toContain("# Using Perch from an agent");
  expect((await perch("--help")).out).toContain("perch skill install claude|codex|grok");

  await perch("status");
  const mode = await perch("clients", "mode", "cli", "ask");
  expect(mode.out).toMatch(/cli\s+ask/);
  await perch("clients", "mode", "cli", "guard");

  const away = await main(["status"], { env: { PERCH_HOME: join(home.dir, "elsewhere") }, cwd: "/", keychain, stdout: () => {}, stderr: () => {}, autostart: false });
  expect(away).toBe(3);
}, 60_000);

test("each terminal window gets its own session; agterm and agmux name theirs", () => {
  expect(defaultSession({ TERM_SESSION_ID: "w0t1p0:4F2A-9" })).toBe("term-w0t1p0:4F2A-9");
  expect(defaultSession({ TMUX_PANE: "%3" })).toBe("term-3");
  expect(defaultSession({ PERCH_SESSION: "tab-7", TERM_SESSION_ID: "w0t1p0:x" })).toBe("tab-7");
  expect(defaultSession({ PERCH_SESSION: "bad id", ITERM_SESSION_ID: "w1t0p0:AB" })).toBe("term-w1t0p0:AB");
  expect(defaultSession({})).toBe("default");
  expect(defaultClient({ PERCH_CLIENT: "agterm" })).toBe("agterm");
  expect(defaultClient({ PERCH_CLIENT: "Not Valid" })).toBe("cli");
  expect(defaultClient({})).toBe("cli");
});

test("a quoted task runs as perch exec, and focus never starts perchd", async () => {
  let err = "";
  // A home of its own, so nothing here can reach or start the person's real perchd.
  const io: CliIO = { env: { PERCH_HOME: join(home.dir, "quoted") }, cwd: "/", keychain, stdout: () => {}, stderr: (t) => void (err += t), autostart: false };
  // An unknown provider is a usage error, caught before perchd is asked.
  expect(await main(["find the cheapest flight", "--model", "nope/x"], io)).toBe(64);
  expect(err).toContain('provider "nope"');
  expect(err).not.toContain("unknown command");

  // A browser command quoted by mistake is refused, not run as a task on the person's plan.
  err = "";
  expect(await main(["click e1"], io)).toBe(64);
  expect(err).toContain("is a command, not a task");
  expect(await main(["eval document.title"], io)).toBe(64);

  const away = await main(["focus", "--client", "agterm", "--session", "T1"], { ...io, env: { PERCH_HOME: join(home.dir, "gone") } });
  expect(away).toBe(3);
});
