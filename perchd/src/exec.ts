/**
 * `perch exec`: run one task and print the answer. Compatible with the Aside CLI's arguments, so
 * Aside's published benchmark runners can drive Perch with `--aside-command perch`.
 *
 *   perch exec [--model claude-code/<model>] [--thinking <level>] [--log-dump <events.jsonl>] "<task>"
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runClaudeCode, runCodex } from "./external";

export type ExecArgs = { provider: string; model: string; thinking?: string; logDump?: string; task: string };

export function parseExecArgs(argv: string[]): ExecArgs {
  const args = [...argv];
  if (args[0] === "exec") args.shift();
  const take = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const [provider, ...rest] = (take("--model") ?? "claude-code/claude-sonnet-5-5").split("/");
  const thinking = take("--thinking");
  const logDump = take("--log-dump");
  const task = args.join(" ").trim();
  if (provider !== "claude-code" && provider !== "codex") throw new Error(`provider "${provider}" needs Perch's own sign-in, which is not built yet; use claude-code/<model> or codex/<model>`);
  if (!task) throw new Error("give the task in quotes");
  return { provider, model: rest.join("/") || (provider === "codex" ? "gpt-6-astra" : "claude-sonnet-5-5"), ...(thinking ? { thinking } : {}), ...(logDump ? { logDump } : {}), task };
}

async function main(argv: string[]): Promise<number> {
  let args: ExecArgs;
  try {
    args = parseExecArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 64;
  }
  const run = args.provider === "codex" ? runCodex : runClaudeCode;
  const result = await run({
    task: args.task,
    model: args.model,
    timeoutMs: 30 * 60_000,
    auditPath: join(homedir(), "Library", "Application Support", "Perch", "exec-audit.jsonl"),
  });
  if (args.logDump) writeFileSync(args.logDump, result.events.map((e) => JSON.stringify(e)).join("\n"));
  process.stdout.write(`${result.answer}\n`);
  return result.answer ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
