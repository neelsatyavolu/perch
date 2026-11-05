import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/mcp-client/cli";
import { MemoryKeychain } from "../src/secure/keychain";

const home = mkdtempSync(join(tmpdir(), "perch-cli-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const FAKE = "ghp_cliFAKE999";
const SERVER = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "npx", args: ["server-github"], env: { GITHUB_TOKEN: FAKE } }, fixture: { command: process.execPath, args: [SERVER] } } }));
mkdirSync(join(home, ".claude", "skills", "notes"), { recursive: true });
writeFileSync(join(home, ".claude", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Take notes.\n---\nBody");

const kc = new MemoryKeychain();
async function cli(args: string[], answer = true) {
  const lines: string[] = [];
  const code = await run(args, { keychain: kc, home, env: {}, out: (l) => lines.push(l), ask: async () => answer });
  return { code, text: lines.join("\n") };
}

test("import shows a preview and saves nothing without --save", async () => {
  const r = await cli(["import"]);
  expect(r.text).toContain("[x] github  (Claude Code (user), will import)");
  expect(r.text).toContain("to the Keychain: env GITHUB_TOKEN");
  expect(r.text).not.toContain(FAKE);
  expect(r.text).toContain("Nothing saved.");
  expect((await cli(["list"])).text).toContain("No MCP servers yet.");
});

test("import --save, list, tools, trust and remove", async () => {
  expect((await cli(["import", "--save", "all"])).text).toContain("Imported github, fixture.");
  expect(await kc.get("mcp/github/env/GITHUB_TOKEN")).toBe(FAKE);
  expect((await cli(["list"])).text).toContain("github  on  stdio npx  (from Claude Code (user))");
  const tools = await cli(["tools", "fixture"]);
  expect(tools.code).toBe(0);
  expect(tools.text).toContain("read echo  Repeat the text.");
  expect((await cli(["tools", "github"], false)).text).toContain("github: declined. You did not allow this server to run.");
  await cli(["trust", "github"]);
  expect((await cli(["list"])).text).toContain("github  on, trusted");
  await cli(["remove", "github"]);
  expect(await kc.get("mcp/github/env/GITHUB_TOKEN")).toBeNull();
  expect((await cli(["list"])).text).not.toContain("github");
});

test("skills import and list", async () => {
  expect((await cli(["skills", "import", "--save", "all"])).text).toContain("Imported notes.");
  const list = (await cli(["skills"])).text;
  expect(list).toContain("notes  (mine)  Take notes.");
  expect(list).toContain("gmail  (built-in)");
});
