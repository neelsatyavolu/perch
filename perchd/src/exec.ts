/**
 * `perch exec`: run one task and print the answer. Compatible with the Aside CLI's arguments, so
 * Aside's published benchmark runners can drive Perch with `--aside-command perch`.
 *
 *   perch exec [--model claude-code/<model>] [--thinking <level>] [--log-dump <events.jsonl>] "<task>"
 */

import { writeFileSync } from "node:fs";
import { perchPaths } from "./daemon/paths";
import { runClaudeCode, runCodex } from "./external";
import { cfPreferences } from "./policy/cfprefs";
import { AGENT_OFF, agentAllowed, allowsModel, MODEL_NOT_ALLOWED } from "./policy/policy";
import { PolicyWatcher } from "./policy/watch";

export type ExecArgs = { provider: string; model: string; thinking?: string; logDump?: string; task: string };

/** Aside's provider names, for `-m openai/<model>` and `-m anthropic/<model>`. */
const PROVIDERS: Record<string, string> = { openai: "codex", anthropic: "claude-code", claude: "claude-code" };

export function parseExecArgs(argv: string[]): ExecArgs {
  const args = [...argv];
  if (args[0] === "exec") args.shift();
  const take = (...names: string[]) => {
    let value: string | undefined;
    for (const name of names) {
      const i = args.indexOf(name);
      if (i >= 0) value = args.splice(i, 2)[1];
    }
    return value;
  };
  const drop = (...names: string[]) => names.forEach((n) => args.includes(n) && args.splice(args.indexOf(n), 1));
  // `perch exec` options that only matter inside Perch's app; a task run on its own ignores them.
  take("--timeout", "--permission", "--session");
  drop("--json", "--standalone");
  const providerName = take("-p", "--provider");
  const named = take("-m", "--model");
  const spec = named ? (named.includes("/") || !providerName ? named : `${providerName}/${named}`) : "claude-code/claude-sonnet-5-5";
  const [given, ...rest] = spec.includes("/") ? spec.split("/") : [spec.startsWith("gpt") ? "codex" : "claude-code", spec];
  const provider = PROVIDERS[given!] ?? given!;
  const thinking = take("--thinking", "--effort");
  const logDump = take("--log-dump");
  const task = args.join(" ").trim();
  if (provider !== "claude-code" && provider !== "codex") throw new Error(`provider "${provider}" needs Perch's own sign-in, which is not built yet; use claude-code/<model> or codex/<model>`);
  if (!task) throw new Error("give the task in quotes");
  return { provider, model: rest.join("/") || (provider === "codex" ? "gpt-6-astra" : "claude-sonnet-5-5"), ...(thinking ? { thinking } : {}), ...(logDump ? { logDump } : {}), task };
}

export async function main(argv: string[]): Promise<number> {
  let args: ExecArgs;
  try {
    args = parseExecArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 64;
  }
  const policy = new PolicyWatcher({ source: cfPreferences(), watchDir: null }).current();
  const refused = !agentAllowed(policy) ? AGENT_OFF : !allowsModel(args.provider, args.model, policy) ? MODEL_NOT_ALLOWED : null;
  if (refused) {
    process.stderr.write(`${refused}\n`);
    return 77;
  }
  const run = args.provider === "codex" ? runCodex : runClaudeCode;
  const result = await run({
    task: args.task,
    model: args.model,
    ...(args.thinking ? { effort: args.thinking } : {}),
    timeoutMs: 30 * 60_000,
    auditPath: perchPaths().auditFile,
  });
  if (args.logDump) writeFileSync(args.logDump, result.events.map((e) => JSON.stringify(e)).join("\n"));
  process.stdout.write(`${result.answer}\n`);
  return result.answer ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
