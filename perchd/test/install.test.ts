import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, NOTE, uninstall, type InstallEnv } from "../src/cli/install/index";

let home: string;
let ienv: InstallEnv;
const at = new Date("2026-11-05T10:20:30Z");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "perch-install-"));
  ienv = { home, env: {}, command: ["/Applications/Perch.app/Contents/MacOS/perch"], now: () => at };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes(".perch-backup-"));

test("Claude Code: merges the MCP server into ~/.claude.json with a backup, and uninstall removes only Perch's parts", () => {
  const file = join(home, ".claude.json");
  const original = { numStartups: 4, mcpServers: { consult: { command: "node", args: ["c.mjs"] } }, projects: { "/x": { mcpServers: {} } } };
  writeFileSync(file, JSON.stringify(original, null, 2), { mode: 0o600 });

  const changes = install("claude", ienv);
  const config = JSON.parse(readFileSync(file, "utf8"));
  expect(config.mcpServers.perch).toEqual({ type: "stdio", command: "/Applications/Perch.app/Contents/MacOS/perch", args: ["mcp", "--client", "claude-code"], env: {} });
  expect(config.mcpServers.consult).toEqual(original.mcpServers.consult);
  expect(config.numStartups).toBe(4);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(backups(home)).toEqual([".claude.json.perch-backup-20261105-102030"]);
  expect(statSync(join(home, ".claude.json.perch-backup-20261105-102030")).mode & 0o777).toBe(0o600);
  const skill = join(home, ".claude", "skills", "perch", "SKILL.md");
  expect(readFileSync(skill, "utf8")).toContain("name: perch");
  expect(changes.map((c) => c.action)).toEqual(["created", "updated", "created"]);
  expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(`${NOTE}\n`);

  expect(install("claude", { ...ienv, now: () => new Date("2026-11-06T00:00:00Z") }).map((c) => c.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
  expect(backups(home)).toHaveLength(1);

  uninstall("claude", ienv);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
  expect(existsSync(join(home, ".claude", "skills", "perch"))).toBe(false);
  expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
});

test("the line about Perch joins the agent's own instructions once, and leaves the rest as it was", () => {
  const notes = join(home, ".codex", "AGENTS.md");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(notes, "# My rules\n\nAlways run the tests.\n");
  install("codex", ienv);
  install("codex", ienv);
  expect(readFileSync(notes, "utf8")).toBe(`# My rules\n\nAlways run the tests.\n\n${NOTE}\n`);
  uninstall("codex", ienv);
  expect(readFileSync(notes, "utf8")).toBe("# My rules\n\nAlways run the tests.\n");
});

test("Claude Code: a perch server the user set up by hand, or a skill of theirs, is left alone", () => {
  const file = join(home, ".claude.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { perch: { command: "my-own-perch" } } }));
  mkdirSync(join(home, ".claude", "skills", "perch"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "perch", "SKILL.md"), "---\nname: perch\n---\nmine\n");
  const changes = install("claude", ienv);
  expect(changes.map((c) => c.action)).toEqual(["skipped", "skipped", "created"]);
  expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.perch).toEqual({ command: "my-own-perch" });
  expect(readFileSync(join(home, ".claude", "skills", "perch", "SKILL.md"), "utf8")).toContain("mine");
  expect(uninstall("claude", ienv).map((c) => c.action)).toEqual(["skipped", "skipped", "removed"]);
});

test("Claude Code: a new config file is created private, and CLAUDE_CONFIG_DIR is honoured", () => {
  const dir = join(home, "alt");
  install("claude", { ...ienv, env: { CLAUDE_CONFIG_DIR: dir } });
  expect(statSync(join(dir, ".claude.json")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dir, "skills", "perch", "SKILL.md"))).toBe(true);
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
});

test("Codex: a marked block in config.toml, idempotent, updated in place, removed exactly", () => {
  mkdirSync(join(home, ".codex"));
  const file = join(home, ".codex", "config.toml");
  const original = 'model = "gpt-6"\n\n[mcp_servers.parallel]\ncommand = "npx"\n\n[projects."/tmp/x"]\ntrust_level = "trusted"\n';
  writeFileSync(file, original, { mode: 0o644 });

  install("codex", ienv);
  const text = readFileSync(file, "utf8");
  const parsed = Bun.TOML.parse(text) as any;
  expect(parsed.mcp_servers.perch).toEqual({ command: "/Applications/Perch.app/Contents/MacOS/perch", args: ["mcp", "--client", "codex"], tool_timeout_sec: 120 });
  expect(parsed.projects["/tmp/x"].trust_level).toBe("trusted");
  expect(statSync(file).mode & 0o777).toBe(0o644);
  expect(readFileSync(join(home, ".codex", "skills", "perch", "SKILL.md"), "utf8")).toContain("installed-by: perch");

  expect(install("codex", ienv).map((c) => c.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
  install("codex", { ...ienv, command: ["/usr/local/bin/perch"] });
  const updated = readFileSync(file, "utf8");
  expect(updated.match(/perch:begin/g)).toHaveLength(1);
  expect(updated).toContain('command = "/usr/local/bin/perch"');

  uninstall("codex", ienv);
  expect(readFileSync(file, "utf8")).toBe(original);
});

test("Codex and Grok: CODEX_HOME and GROK_HOME are honoured; a hand-made perch table or broken TOML is not touched", () => {
  const codexHome = join(home, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.perch]\ncommand = "mine"\n');
  expect(install("codex", { ...ienv, env: { CODEX_HOME: codexHome } })[1]).toMatchObject({ action: "skipped" });
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe('[mcp_servers.perch]\ncommand = "mine"\n');

  const grokHome = join(home, "grok-home");
  mkdirSync(grokHome);
  writeFileSync(join(grokHome, "config.toml"), "[cli\nbroken = ");
  expect(() => install("grok", { ...ienv, env: { GROK_HOME: grokHome } })).toThrow("is not valid TOML");
  expect(readFileSync(join(grokHome, "config.toml"), "utf8")).toBe("[cli\nbroken = ");

  rmSync(join(grokHome, "config.toml"));
  install("grok", { ...ienv, env: { GROK_HOME: grokHome } });
  expect((Bun.TOML.parse(readFileSync(join(grokHome, "config.toml"), "utf8")) as any).mcp_servers.perch.args).toEqual(["mcp", "--client", "grok"]);
  expect(existsSync(join(grokHome, "skills", "perch", "SKILL.md"))).toBe(true);
});
