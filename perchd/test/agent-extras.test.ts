import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentExtras } from "../src/mcp-client/agent-extras";
import { addServer, EMPTY, RegistryStore } from "../src/mcp-client/registry";
import { MemoryKeychain } from "../src/secure/keychain";
import { SkillStore } from "../src/skills/store";

const SERVER = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
const dir = mkdtempSync(join(tmpdir(), "perch-extras-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a real run gets the user's MCP tools and skills, built-in skills included", async () => {
  const kc = new MemoryKeychain();
  await new RegistryStore(join(dir, "mcp-servers.enc"), kc).save(addServer(EMPTY, { name: "fixture", config: { transport: "stdio", command: process.execPath, args: [SERVER], env: {} }, enabled: true, trusted: false, addedAt: "x" }));
  await new SkillStore(join(dir, "skills"), kc).install({ name: "my-notes", description: "Take notes my way.", files: { "SKILL.md": Buffer.from("---\nname: my-notes\ndescription: Take notes my way.\n---\nBody").toString("base64") } }, "test");
  const asked: string[] = [];
  const extras = await loadAgentExtras({ dir, keychain: kc, env: {}, approveLaunch: async (r) => (asked.push(r.server), true), openUrl: async () => undefined });
  try {
    expect(asked).toEqual(["fixture"]);
    expect(extras.status).toEqual([{ name: "fixture", state: "connected", tools: 9 }]);
    const names = extras.extraTools.specs().map((s) => s.name);
    expect(names).toContain("mcp__fixture__echo");
    expect(names).toContain("load_skill");
    const prompt = extras.extraTools.prompt();
    expect(prompt).toContain("- my-notes: Take notes my way.");
    expect(prompt).toContain("- gmail:");
    expect(prompt).toContain("mcp__<server>__<tool>");
  } finally {
    await extras.close();
  }
});

test("without settings, only the built-in skills are offered", async () => {
  const extras = await loadAgentExtras({ dir: join(dir, "empty"), keychain: new MemoryKeychain(), env: {}, approveLaunch: async () => false, openUrl: async () => undefined });
  expect(extras.status).toEqual([]);
  expect(extras.extraTools.specs().map((s) => s.name)).toEqual(["load_skill"]);
  await extras.close();
});
