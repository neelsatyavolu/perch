/**
 * Perch benchmark runner.
 *
 *   bun run bench/run.ts --suite bu|om2w [--agent claude-code|codex] [--limit N] [--per-category K] [--concurrency 2]
 *                        [--model claude-sonnet-5-5] [--judge claude-opus-5-5] [--out <dir>] [--resume]
 *                        [--executable <Perch.app/Contents/MacOS/Perch>]   drive a real Perch build in a window
 *
 * Suites: BU Bench V1 (bench/data/bu-bench-v1.json, from Aside's published runner) and
 * Online-Mind2Web (bench/data/Online_Mind2Web.json, gated on Hugging Face). Each task writes
 * events.jsonl, answer.txt, audit.jsonl and result.json; summary.md has the pass rates.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaudeCode, runCodex } from "../perchd/src/external";
import { judge } from "./judge";

type Task = { id: string; category: string; task: string; reference?: string; website?: string };
type Result = Task & { verdict: string; reason: string; seconds: number; steps: number; answer: string; timedOut: boolean };

const ROOT = import.meta.dir;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function loadSuite(suite: string): Task[] {
  if (suite === "bu") {
    const data = JSON.parse(readFileSync(join(ROOT, "data", "bu-bench-v1.json"), "utf8")) as { task_id: string; category: string; confirmed_task: string; answer?: string }[];
    return data.map((t) => ({ id: t.task_id, category: t.category, task: t.confirmed_task, reference: t.answer || undefined }));
  }
  const data = JSON.parse(readFileSync(join(ROOT, "data", "Online_Mind2Web.json"), "utf8")) as { task_id: string; website: string; confirmed_task?: string; task_description?: string; level: string }[];
  return data.map((t) => ({ id: t.task_id, category: t.level, task: `${t.confirmed_task ?? t.task_description}\nStart at: ${t.website}`, website: t.website }));
}

function pick(tasks: Task[]): Task[] {
  const per = arg("--per-category");
  let chosen = tasks;
  if (per) {
    const counts = new Map<string, number>();
    chosen = tasks.filter((t) => {
      const n = counts.get(t.category) ?? 0;
      counts.set(t.category, n + 1);
      return n < Number(per);
    });
  }
  const limit = arg("--limit");
  return limit ? chosen.slice(0, Number(limit)) : chosen;
}

/**
 * Waits until the Mac is safe to load: on the charger, no heat or slowdown warning from macOS, and
 * the load average under 80% of the cores. A full-core build once shut this MacBook down.
 */
async function waitUntilSafe(): Promise<void> {
  const { cpus, loadavg } = await import("node:os");
  for (let waited = 0; ; waited++) {
    const batt = Bun.spawnSync(["pmset", "-g", "batt"]).stdout.toString();
    const therm = Bun.spawnSync(["pmset", "-g", "therm"]).stdout.toString();
    const onAC = batt.includes("AC Power");
    const hot = /(thermal|performance) warning level[^0-9]*[1-9]/i.test(therm) || /CPU_Speed_Limit\s*=\s*([0-7]?\d)\b/.test(therm);
    const busy = loadavg()[0]! > cpus().length * 0.8;
    if (onAC && !hot && !busy) return;
    if (waited % 5 === 0) process.stderr.write(`waiting: ${!onAC ? "on battery " : ""}${hot ? "heat warning " : ""}${busy ? `load ${loadavg()[0]!.toFixed(1)}` : ""}\n`);
    await Bun.sleep(60_000);
  }
}

async function runOne(task: Task, out: string, model: string, judgeModel: string): Promise<Result> {
  await waitUntilSafe();
  const dir = join(out, task.id.replace(/[^\w.-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const runner = arg("--agent", "claude-code") === "codex" ? runCodex : runClaudeCode;
  const mode = (arg("--mode", "skip") ?? "skip") as "ask" | "guard" | "skip";
  const executable = arg("--executable");
  const run = await runner({ task: task.task, model, timeoutMs: 15 * 60_000, auditPath: join(dir, "audit.jsonl"), mode, ...(executable ? { executable } : { userAgent: UA }) });
  const seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(dir, "events.jsonl"), run.events.map((e) => JSON.stringify(e)).join("\n"));
  writeFileSync(join(dir, "answer.txt"), run.answer);
  const graded = run.answer || run.events.length ? await judge({ task: task.task, reference: task.reference, answer: run.answer, events: run.events, model: judgeModel }) : { verdict: "error" as const, reason: `no output; exit ${run.exitCode}; ${run.stderr.slice(-300)}` };
  const steps = run.events.filter((e) => e.type === "tool_execution_start").length;
  const result: Result = { ...task, verdict: graded.verdict, reason: graded.reason, seconds, steps, answer: run.answer, timedOut: run.timedOut };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

function summarize(results: Result[], label: string): string {
  const rate = (rs: Result[]) => {
    const pass = rs.filter((r) => r.verdict === "pass").length;
    const impossible = rs.filter((r) => r.verdict === "impossible").length;
    const counted = rs.length - impossible;
    return `${pass}/${rs.length} (${((pass / Math.max(1, rs.length)) * 100).toFixed(1)}%; ${((pass / Math.max(1, counted)) * 100).toFixed(1)}% excluding ${impossible} impossible)`;
  };
  const cats = [...new Set(results.map((r) => r.category))];
  return [
    `# ${label}`,
    "",
    `Overall: ${rate(results)}`,
    "",
    "| Category | Result |",
    "|---|---|",
    ...cats.map((c) => `| ${c} | ${rate(results.filter((r) => r.category === c))} |`),
    "",
    "| Task | Category | Verdict | Steps | Seconds | Reason |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.category} | ${r.verdict} | ${r.steps} | ${r.seconds} | ${r.reason.replace(/\|/g, "/").replace(/\n/g, " ")} |`),
  ].join("\n");
}

async function main(): Promise<void> {
  const suite = arg("--suite", "bu")!;
  const model = arg("--model", "claude-sonnet-5-5")!;
  const judgeModel = arg("--judge", "claude-opus-5-5")!;
  const concurrency = Number(arg("--concurrency", "2"));
  const out = arg("--out", join(ROOT, "results", `${suite}-${model}`))!;
  mkdirSync(out, { recursive: true });
  const tasks = pick(loadSuite(suite));
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      const done = join(out, task.id.replace(/[^\w.-]/g, "_"), "result.json");
      if (process.argv.includes("--resume") && existsSync(done)) {
        results.push(JSON.parse(readFileSync(done, "utf8")));
        continue;
      }
      const r = await runOne(task, out, model, judgeModel).catch((e) => ({ ...task, verdict: "error", reason: String(e), seconds: 0, steps: 0, answer: "", timedOut: false }));
      results.push(r);
      process.stderr.write(`${results.length}/${tasks.length} ${r.verdict.padEnd(10)} ${r.category.padEnd(16)} ${r.steps} steps ${r.seconds}s  ${task.task.slice(0, 70).replace(/\n/g, " ")}\n`);
      writeFileSync(join(out, "summary.md"), summarize(results, `${suite} · ${model} · judged by ${judgeModel}`));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeFileSync(join(out, "summary.md"), summarize(results, `${suite} · ${model} · judged by ${judgeModel}`));
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  process.stdout.write(`${readFileSync(join(out, "summary.md"), "utf8").split("\n").slice(0, 12).join("\n")}\n`);
}

await main();
