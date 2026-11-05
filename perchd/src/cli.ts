/**
 * Development harness: run one task in a headless test browser and print the steps.
 *
 *   bun run src/cli.ts run [--model fake|role:<role>|<provider>[:<model-id>]] [--mode ask|guard|skip] [--show] "<task>"
 *   bun run src/cli.ts models …   (connect providers and set task models; see src/models-cli.ts)
 *
 * Providers come from Settings → Models (the Keychain and encrypted settings). A Claude API key
 * can still be given in ANTHROPIC_API_KEY. Approvals are asked on this terminal.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { AuditLog } from "./agent/audit";
import { runTask } from "./agent/loop";
import type { Mode } from "./agent/permissions";
import { Browser } from "./browser/browser";
import { anthropicModel } from "./models/anthropic";
import { fakeModel } from "./models/fake";
import { PROVIDERS } from "./models/providers";
import type { Effort, Model } from "./models/types";
import { modelsCommand, openRegistry, parseModelSpec } from "./models-cli";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

type Picked = { model: Model; effort?: Effort } | string;

/** fake, role:<role>, <provider> or <provider>:<model>, from the providers connected with `models`. */
async function pickModel(spec: string): Promise<Picked> {
  if (spec === "fake") return { model: fakeModel([[{ type: "tool_call", call: { id: "c1", name: "done", args: { answer: "The fake model does nothing." } } }, { type: "done" }]]) };
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (spec.startsWith("anthropic") && envKey) return { model: anthropicModel({ model: spec.split(":")[1] ?? "claude-sonnet-5-5", apiKey: async () => envKey }) };
  try {
    const parsed = parseModelSpec(spec);
    const registry = await openRegistry();
    try {
      const target = "role" in parsed ? parsed.role : { provider: parsed.provider, model: parsed.model ?? PROVIDERS[parsed.provider].defaults.default ?? (await registry.listModels(parsed.provider))[0]?.id ?? "" };
      const handle = await registry.modelFor(target);
      if (handle.kind === "runner") return `Claude Code runs whole tasks: use perch exec --model claude-code/${handle.model}.`;
      return { model: handle.model, ...(handle.effort ? { effort: handle.effort } : {}) };
    } finally {
      registry.dispose();
    }
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)} Connect providers with: bun run src/cli.ts models providers`;
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  if (command === "models") return modelsCommand(args);
  if (command !== "run") {
    process.stderr.write('usage: perchd-dev run [--model fake|role:<role>|<provider>[:<model>]] [--mode ask|guard|skip] [--show] "<task>"\n       perchd-dev models …\n');
    return 64;
  }
  const picked = await pickModel(arg(args, "--model") ?? "fake");
  const mode = (arg(args, "--mode") ?? "guard") as Mode;
  const show = args.includes("--show");
  const task = args.filter((a) => a !== "--show").join(" ").trim();
  if (typeof picked === "string") {
    process.stderr.write(`${picked}\n`);
    return 2;
  }
  if (!task) {
    process.stderr.write("Give the task in quotes.\n");
    return 64;
  }
  const profile = mkdtempSync(join(tmpdir(), "perchd-dev-"));
  const browser = await Browser.launch({ userDataDir: profile, headless: !show });
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const audit = new AuditLog(join(homedir(), "Library", "Application Support", "Perch", "dev-audit.jsonl"));
  let code = 0;
  try {
    for await (const event of runTask({
      model: picked.model,
      effort: picked.effort,
      browser,
      task,
      mode,
      audit,
      client: "dev-cli",
      approve: async (req) => (await terminal.question(`Allow: ${req.summary}? [y/N] `)).trim().toLowerCase() === "y",
    })) {
      if (event.type === "step") process.stderr.write(`· ${event.label}\n`);
      if (event.type === "final") process.stdout.write(`${event.text}\n`);
      if (event.type === "error") {
        process.stderr.write(`${event.message}\n`);
        code = 1;
      }
    }
  } finally {
    terminal.close();
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
