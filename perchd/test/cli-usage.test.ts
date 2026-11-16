import { expect, test } from "bun:test";
import { join } from "node:path";
import { main, type CliIO } from "../src/cli/main";
import { closest } from "../src/cli/args";
import { TOOL_SPECS } from "../src/agent/tool-specs";
import { MemoryKeychain } from "../src/daemon/keychain";
import guide from "../skills/perch/guide.md" with { type: "text" };
import { tempProfile } from "./helpers";

// A home with no perchd in it: nothing here can reach or start the person's real Perch.
const home = tempProfile();

async function perch(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIO = {
    env: { PERCH_HOME: join(home.dir, "nobody"), HOME: home.dir },
    cwd: "/",
    keychain: new MemoryKeychain(),
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    autostart: false,
  };
  const code = await main(argv, io);
  return { code, out, err };
}

test("closest picks a near name, and nothing when every name is far off", () => {
  expect(closest("snapshto", ["snapshot", "screenshot", "scroll"])).toBe("snapshot");
  expect(closest("sesion", ["session", "sessions", "status"])).toBe("session");
  expect(closest("--sesion", ["--full", "--session"])).toBe("--session");
  expect(closest("xyzzy", ["snapshot", "click"])).toBeUndefined();
});

test("an unknown command suggests the closest one, briefly, instead of printing all the help", async () => {
  const typo = await perch("snapshto");
  expect(typo.code).toBe(64);
  expect(typo.err).toBe('perch: unknown command "snapshto". Did you mean perch snapshot?\nRun perch --help to see every command.\n');
  const far = await perch("xyzzy");
  expect(far).toMatchObject({ code: 64, err: 'perch: unknown command "xyzzy".\nRun perch --help to see every command.\n' });
  const action = await perch("session", "lst");
  expect(action.code).toBe(64);
  expect(action.err).toStartWith('perch: unknown session command "lst". Did you mean perch session list?\n');
});

test("an unknown option suggests the closest one the command takes", async () => {
  expect((await perch("snapshot", "--sesion", "x")).err).toBe("perch: unknown option --sesion (did you mean --session?); this command takes --full, --session\n");
});

test("perch session --help prints every session command, not just the summary line", async () => {
  const help = await perch("session", "--help");
  expect(help.code).toBe(0);
  expect(help.out).toContain('steer <id> "<message>"');
  expect(help.out).toContain("Ids can be shortened");
});

test("the new browser commands have help and check their arguments before reaching Perch", async () => {
  for (const name of ["find", "hover", "wait", "switch", "downloads", "read"]) {
    const help = await perch(name, "--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain(`perch ${name}`);
  }
  expect((await perch("find")).err).toContain("usage: perch find");
  expect((await perch("hover")).err).toContain("usage: perch hover <ref>");
  expect((await perch("wait")).err).toContain("usage: perch wait");
  expect((await perch("wait", "--seconds", "soon")).code).toBe(64);
  expect((await perch("wait", "Done", "--timeout", "2x")).code).toBe(64);
  expect((await perch("switch")).err).toContain("usage: perch switch <tab id>");
  expect((await perch("read")).err).toContain("usage: perch read");
  expect((await perch("read", "https://example.com/a.pdf", "--from", "-5")).code).toBe(64);
});

test("when Perch isn't running, commands say so plainly and exit 3; status --json still prints JSON", async () => {
  const status = await perch("status", "--json");
  expect(status.code).toBe(3);
  expect(JSON.parse(status.out)).toEqual({ running: false });
  const snap = await perch("status");
  expect(snap).toMatchObject({ code: 3, err: "Perch is not running. Open Perch, then try again.\n" });
  // Flags are checked first: a good one reaches the not-running check, a typo is a usage error.
  expect((await perch("models", "--json")).code).toBe(3);
  expect((await perch("models", "--jsn")).code).toBe(64);
  expect((await perch("skills", "list", "--json")).code).toBe(3);
  expect((await perch("clients", "--json")).code).toBe(3);
  expect((await perch("memory", "search", "flights", "--limit", "lots")).code).toBe(64);
});

test("the guide names every tool an outside agent can call", () => {
  const missing = TOOL_SPECS.filter((t) => t.name !== "done" && !guide.includes(`\`${t.name}\``)).map((t) => t.name);
  expect(missing).toEqual([]);
});
