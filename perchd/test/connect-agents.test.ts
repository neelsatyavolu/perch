import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStates, commandState, connectAgents, installCommand } from "../src/cli/install/connect";
import { NOTE, type InstallEnv } from "../src/cli/install/index";
import { stableBinary } from "../src/cli/self";

let home: string;
let ienv: InstallEnv;
const BINARY = "/Applications/Perch.app/Contents/Frameworks/Perch Framework.framework/Helpers/perchd";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "perch-connect-"));
  ienv = { home, env: { SHELL: "/bin/zsh" }, command: [BINARY], now: () => new Date("2026-11-13T10:00:00Z") };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("one click: the perch command, PATH, and the skill, MCP server and a line about Perch in every agent found", () => {
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "AGENTS.md"), "# Mine\n");
  const result = connectAgents(["claude", "codex", "grok"], ienv);

  expect(readlinkSync(join(home, ".local", "bin", "perch"))).toBe(BINARY);
  expect(result.command).toEqual({ installed: true, path: join(home, ".local", "bin", "perch"), shellFile: join(home, ".zprofile") });
  expect(readFileSync(join(home, ".zprofile"), "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
  expect(result.agents).toEqual([
    { id: "claude", found: true, installed: true },
    { id: "codex", found: true, installed: true },
    { id: "grok", found: false, installed: false },
  ]);
  expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(`${NOTE}\n`);
  expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe(`# Mine\n\n${NOTE}\n`);
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.perch.command).toBe(BINARY);
  expect(existsSync(join(home, ".grok"))).toBe(false);

  // Again: nothing doubles up.
  connectAgents(["claude", "codex", "grok"], ienv);
  expect(readFileSync(join(home, ".zprofile"), "utf8").match(/\.local\/bin/g)).toHaveLength(1);
  expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8").split(NOTE)).toHaveLength(2);
  expect(agentStates(["claude", "grok"], ienv)).toEqual([{ id: "claude", found: true, installed: true }, { id: "grok", found: false, installed: false }]);
  expect(commandState(ienv).installed).toBe(true);
});

test("PATH is left alone when a startup file already names ~/.local/bin; bash gets .bash_profile", () => {
  writeFileSync(join(home, ".zshrc"), 'path+=("$HOME/.local/bin")\n');
  expect(installCommand(ienv).shellFile).toBeUndefined();
  rmSync(join(home, ".zshrc"));
  rmSync(join(home, ".local"), { recursive: true });
  expect(installCommand({ ...ienv, env: { SHELL: "/bin/bash" } }).shellFile).toBe(join(home, ".bash_profile"));
});

test("a perch command Perch didn't make is left as it is; an older Perch's link is replaced", () => {
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "perch"), "#!/bin/sh\necho mine\n");
  expect(installCommand(ienv)).toMatchObject({ installed: false, note: expect.stringContaining("didn't make") });
  rmSync(join(home, ".local", "bin", "perch"));
  symlinkSync("/Old/Perch.app/Contents/Frameworks/Perch Framework.framework/Versions/1/Helpers/perchd", join(home, ".local", "bin", "perch"));
  expect(installCommand(ienv).installed).toBe(true);
  expect(readlinkSync(join(home, ".local", "bin", "perch"))).toBe(BINARY);
});

test("a development build can't install the command", () => {
  expect(installCommand({ ...ienv, command: ["/usr/local/bin/bun", "run", "main.ts"] })).toMatchObject({ installed: false });
});

test("saved commands point at the framework's Helpers link, which survives updates", () => {
  const versioned = "/Applications/Perch.app/Contents/Frameworks/Perch Framework.framework/Versions/158.0.8127.18/Helpers/perchd";
  expect(stableBinary(versioned, () => true)).toBe(BINARY);
  expect(stableBinary(versioned, () => false)).toBe(versioned);
  expect(stableBinary("/usr/local/bin/perchd", () => true)).toBe("/usr/local/bin/perchd");
});

test("perchd inside a copy of Perch drives that copy, not the installed app", async () => {
  const { browserExecutable } = await import("../src/daemon/daemon");
  const dev = "/tmp/x/Perch-dev.app/Contents/Frameworks/Perch Framework.framework/Helpers/perchd";
  expect(browserExecutable(undefined, dev, () => true)).toBe("/tmp/x/Perch-dev.app/Contents/MacOS/Perch");
  expect(browserExecutable(undefined, "/usr/local/bin/bun", (p) => p.startsWith("/Applications/"))).toBe("/Applications/Perch.app/Contents/MacOS/Perch");
  expect(browserExecutable("/custom/Chrome", dev, () => true)).toBe("/custom/Chrome");
});
