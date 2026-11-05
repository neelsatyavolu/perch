/**
 * Development harness: run one task in a headless test browser and print the steps.
 *
 *   bun run src/cli.ts run [--model fake|codex|grok|anthropic:<model-id>] [--mode ask|guard|skip] [--show] "<task>"
 *
 * Codex and Grok need the sign-in that Perch's settings add (plan 4). A Claude API key can be
 * given in ANTHROPIC_API_KEY. Approvals are asked on this terminal.
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
import type { Model } from "./models/types";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

function pickModel(spec: string): Model | string {
  if (spec === "fake") return fakeModel([[{ type: "tool_call", call: { id: "c1", name: "done", args: { answer: "The fake model does nothing." } } }, { type: "done" }]]);
  if (spec.startsWith("anthropic")) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return "Set ANTHROPIC_API_KEY to use a Claude API key.";
    return anthropicModel({ model: spec.split(":")[1] ?? "claude-sonnet-5-5", apiKey: async () => key });
  }
  if (spec === "codex" || spec === "grok") return `Signing in to ${spec === "codex" ? "ChatGPT" : "Grok"} comes with Perch's settings (plan 4). Use --model anthropic or fake for now.`;
  return `Unknown model "${spec}". Use fake, codex, grok or anthropic:<model-id>.`;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.shift() !== "run") {
    process.stderr.write('usage: perchd-dev run [--model fake|codex|grok|anthropic:<id>] [--mode ask|guard|skip] [--show] "<task>"\n');
    return 64;
  }
  const model = pickModel(arg(args, "--model") ?? "fake");
  const mode = (arg(args, "--mode") ?? "guard") as Mode;
  const show = args.includes("--show");
  const task = args.filter((a) => a !== "--show").join(" ").trim();
  if (typeof model === "string") {
    process.stderr.write(`${model}\n`);
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
      model,
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
