/**
 * Development harness: run one task in a headless test browser and print the steps.
 *
 *   bun run src/cli.ts run [--model fake|codex|grok|anthropic:<model-id>] [--mode ask|guard|skip] [--show] [--mcp] "<task>"
 *
 * Codex and Grok need the sign-in that Perch's settings add (plan 4). A Claude API key can be
 * given in ANTHROPIC_API_KEY. Approvals are asked on this terminal. Built-in skills are always
 * offered; --mcp also connects the user's MCP servers and skills from Perch's settings (Keychain).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { AuditLog } from "./agent/audit";
import { runTask } from "./agent/loop";
import type { Mode } from "./agent/permissions";
import { Browser } from "./browser/browser";
import { loadAgentExtras, settingsDir, type AgentExtras } from "./mcp-client/agent-extras";
import { describeLaunch } from "./mcp-client/launch";
import { MacKeychain } from "./secure/keychain";
import { SkillCatalog } from "./skills/catalog";
import { skillExtraTools } from "./skills/tool";
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
    process.stderr.write('usage: perchd-dev run [--model fake|codex|grok|anthropic:<id>] [--mode ask|guard|skip] [--show] [--mcp] "<task>"\n');
    return 64;
  }
  const model = pickModel(arg(args, "--model") ?? "fake");
  const mode = (arg(args, "--mode") ?? "guard") as Mode;
  const show = args.includes("--show");
  const withMcp = args.includes("--mcp");
  const task = args.filter((a) => a !== "--show" && a !== "--mcp").join(" ").trim();
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
  const audit = new AuditLog(join(settingsDir(homedir()), "dev-audit.jsonl"));
  // Servers connect at once, so their questions are queued: one prompt on the terminal at a time.
  let asking: Promise<unknown> = Promise.resolve();
  const ask = (question: string): Promise<boolean> => {
    const answer = asking.then(async () => (await terminal.question(`${question} [y/N] `)).trim().toLowerCase() === "y");
    asking = answer.catch(() => undefined);
    return answer;
  };
  let extras: AgentExtras | null = null;
  let code = 0;
  try {
    extras = withMcp
      ? await loadAgentExtras({ dir: settingsDir(homedir()), keychain: new MacKeychain(), approveLaunch: (r) => ask(describeLaunch(r)), openUrl: async (url) => void process.stderr.write(`Open this address to sign in: ${url}\n`) })
      : null;
    for (const s of extras?.status ?? []) if (s.state !== "connected") process.stderr.write(`MCP ${s.name}: ${s.state}${s.error ? `. ${s.error}` : ""}\n`);
    const extraTools = extras?.extraTools ?? skillExtraTools(await SkillCatalog.load());
    for await (const event of runTask({
      model,
      browser,
      task,
      mode,
      audit,
      client: "dev-cli",
      extraTools,
      approve: (req) => ask(`Allow: ${req.summary}?`),
    })) {
      if (event.type === "step") process.stderr.write(`· ${event.label}\n`);
      if (event.type === "final") process.stdout.write(`${event.text}\n`);
      if (event.type === "error") {
        process.stderr.write(`${event.message}\n`);
        code = 1;
      }
    }
  } finally {
    await extras?.close();
    terminal.close();
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
