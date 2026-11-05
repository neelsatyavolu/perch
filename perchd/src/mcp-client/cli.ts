/**
 * Development CLI for MCP servers and skills, until Settings → Skills and MCP exists (plan 3b).
 *
 *   bun run src/mcp-client/cli.ts import [--project <dir>] [--save all|<name,name>]
 *   bun run src/mcp-client/cli.ts list | remove <name> | trust <name> | untrust <name> | enable <name> | disable <name>
 *   bun run src/mcp-client/cli.ts tools <name>
 *   bun run src/mcp-client/cli.ts skills [import [--save all|<name,name>] | list]
 *
 * Settings live in ~/Library/Application Support/Perch (override with --dir); secrets in the Keychain.
 * Nothing is saved without --save, and secret values are never printed.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { MacKeychain, type SecretStore } from "../secure/keychain";
import { SkillCatalog } from "../skills/catalog";
import { findSkillImports, importSkills, previewSkills } from "../skills/import";
import { SkillStore } from "../skills/store";
import { preview, saveImports, type PreviewItem } from "./importers/preview";
import { findImports } from "./importers/sources";
import { deleteServer, McpManager } from "./manager";
import { RegistryStore, updateServer } from "./registry";

export type CliDeps = { keychain: SecretStore; home: string; env: Record<string, string | undefined>; out: (line: string) => void; ask: (question: string) => Promise<boolean> };

function flag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name, i + 1)) if (args[i + 1]) values.push(args[i + 1]!);
  return values;
}

function picked(save: string | undefined, items: { id: number; name: string; selected: boolean }[]): number[] {
  if (!save) return [];
  if (save === "all") return items.filter((i) => i.selected).map((i) => i.id);
  const names = new Set(save.split(",").map((s) => s.trim()));
  return items.filter((i) => names.has(i.name)).map((i) => i.id);
}

function showServer(i: PreviewItem): string[] {
  const state = i.alreadyAdded ? "already in Perch" : i.duplicateOf ? `same as ${i.duplicateOf} above` : i.selected ? "will import" : "off in its app";
  return [
    `${i.selected ? "[x]" : "[ ]"} ${i.name}  (${i.source}, ${state})`,
    `    ${i.transport === "stdio" ? "runs" : `${i.transport.toUpperCase()} at`} ${i.target}`,
    ...(i.secrets.length ? [`    to the Keychain: ${i.secrets.join(", ")}`] : []),
    ...(i.fromEnv.length ? [`    from the environment: ${i.fromEnv.join(", ")}`] : []),
    ...i.warnings.map((w) => `    note: ${w}`),
  ];
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const dir = flag(argv, "--dir")[0] ?? join(deps.home, "Library", "Application Support", "Perch");
  const store = new RegistryStore(join(dir, "mcp-servers.enc"), deps.keychain);
  const skills = new SkillStore(join(dir, "skills"), deps.keychain);
  const [command, name] = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const save = flag(argv, "--save")[0];

  switch (command) {
    case "import": {
      const found = await findImports({ home: deps.home, env: deps.env, projectDirs: flag(argv, "--project") });
      const items = preview(await store.load(), found.candidates);
      if (items.length === 0) deps.out("No MCP servers found in Claude Code, Codex, Claude Desktop, Cursor, Grok or VS Code.");
      for (const i of items) for (const line of showServer(i)) deps.out(line);
      for (const p of found.problems) deps.out(`Skipped ${p.path}: ${p.message}`);
      const ids = picked(save, items);
      if (!save) deps.out(items.length ? "Nothing saved. Run again with --save all, or --save name,name." : "");
      else {
        const result = await saveImports(store, deps.keychain, found.candidates, ids);
        deps.out(result.saved.length ? `Imported ${result.saved.join(", ")}.` : "Nothing new to import.");
        for (const f of result.failed) deps.out(`Could not import ${f.name}: ${f.error}`);
      }
      return 0;
    }
    case "list": {
      const reg = await store.load();
      if (reg.servers.length === 0) deps.out("No MCP servers yet. Run import to bring them in from your other apps.");
      for (const s of reg.servers) {
        const where = s.config.transport === "stdio" ? s.config.command : s.config.url;
        deps.out(`${s.name}  ${s.enabled ? "on" : "off"}${s.trusted ? ", trusted" : ""}  ${s.config.transport} ${where}${s.source ? `  (from ${s.source})` : ""}`);
      }
      return 0;
    }
    case "remove":
    case "trust":
    case "untrust":
    case "enable":
    case "disable": {
      if (!name) return deps.out(`Name the server: ${command} <name>`), 1;
      if (command === "remove") await deleteServer(store, deps.keychain, name);
      else {
        const patch = { trust: { trusted: true }, untrust: { trusted: false }, enable: { enabled: true }, disable: { enabled: false } }[command];
        await store.update((reg) => updateServer(reg, name, patch));
      }
      deps.out(`${name}: done.`);
      return 0;
    }
    case "tools": {
      if (!name) return deps.out("Name the server: tools <name>"), 1;
      const manager = new McpManager({
        store,
        keychain: deps.keychain,
        env: deps.env,
        approveLaunch: (r) => deps.ask(`Run ${r.command} ${r.args.join(" ")} for ${r.server}?`),
        openUrl: async (url) => deps.out(`Open this address to sign in: ${url}`),
      });
      const status = await manager.connect(name);
      if (status.state !== "connected") deps.out(`${name}: ${status.state}${status.error ? `. ${status.error}` : ""}`);
      for (const { tool } of manager.tools()) deps.out(`${tool.annotations.readOnlyHint ? "read " : "      "}${tool.name}  ${tool.description.split("\n")[0]!.slice(0, 100)}`);
      await manager.close();
      return status.state === "connected" ? 0 : 1;
    }
    case "skills": {
      if (name === "import") {
        const found = await findSkillImports({ home: deps.home, env: deps.env });
        const items = previewSkills(new Set(await skills.names()), found.candidates);
        for (const i of items) {
          deps.out(`${i.selected ? "[x]" : "[ ]"} ${i.name}  (${i.source}${i.installed ? ", already in Perch" : ""}) ${i.description.slice(0, 100)}`);
          if (i.scripts.length) deps.out(`    has scripts: ${i.scripts.join(", ")}`);
        }
        for (const p of found.problems) deps.out(`Skipped ${p.path}: ${p.message}`);
        if (save) deps.out(`Imported ${(await importSkills(skills, found.candidates, picked(save, items))).join(", ") || "nothing"}.`);
        return 0;
      }
      for (const s of (await SkillCatalog.load({ store: skills })).list()) deps.out(`${s.name}  (${s.origin})  ${s.description.slice(0, 100)}`);
      return 0;
    }
    default:
      deps.out("Commands: import, list, remove, trust, untrust, enable, disable, tools, skills");
      return command ? 1 : 0;
  }
}

if (import.meta.main) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await run(process.argv.slice(2), {
    keychain: new MacKeychain(),
    home: homedir(),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    ask: async (q) => /^y/i.test(await rl.question(`${q} [y/N] `)),
  }).catch((error: Error) => (process.stderr.write(`${error.message}\n`), 1));
  rl.close();
  process.exit(code);
}
