/** Grades one benchmark run with a headless Claude Code judge. No tools, no MCP servers, no hooks. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeBinary, type AsideEvent } from "../perchd/src/external";

export type Verdict = { verdict: "pass" | "fail" | "impossible" | "error"; reason: string };

const RUBRIC = `You grade a web agent's attempt at a task. Judge only from the evidence: the agent's actions, what the pages returned, and its final answer.

Rules:
- If a reference answer is given, it decides: the final answer must match it in substance, or the verdict is fail.
- Without a reference answer, pass only if the trajectory shows the task was actually done on the live site and the final answer gives what was asked (the right items, counts, values and filters).
- Be doubtful of the agent's own claims of success; look for the page content that supports them.
- Partial answers, wrong filters, made-up values, or stopping early are fail.
- Use "impossible" only when the trajectory shows the site no longer offers what the task needs (item gone, feature removed), not when the agent merely failed. A CAPTCHA or a login wall the agent could not pass is fail, with the reason.
- The agent declining to buy, send or submit at the final step is correct when the task only asks to get there (add to cart, fill a form); judge whether everything before that was done.

Reply with JSON only: {"verdict": "pass" | "fail" | "impossible", "reason": "at most three sentences"}`;

function trajectory(events: AsideEvent[], limit = 60_000): string {
  const lines = events.map((e) =>
    e.type === "tool_execution_start" ? `ACTION ${e.toolName} ${JSON.stringify(e.args)}` : `${e.message.role === "toolResult" ? "RESULT" : "AGENT"}: ${e.message.content[0]?.text ?? ""}`,
  );
  const all = lines.join("\n");
  return all.length > limit ? `[earlier steps cut]\n${all.slice(-limit)}` : all;
}

export async function judge(opts: { task: string; reference?: string; answer: string; events: AsideEvent[]; model: string }): Promise<Verdict> {
  const work = mkdtempSync(join(tmpdir(), "perch-judge-"));
  const mcp = join(work, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  const prompt = [
    `TASK:\n${opts.task}`,
    opts.reference ? `REFERENCE ANSWER:\n${opts.reference}` : "REFERENCE ANSWER: none",
    `TRAJECTORY:\n${trajectory(opts.events)}`,
    `FINAL ANSWER:\n${opts.answer || "(none)"}`,
  ].join("\n\n");
  const child = Bun.spawn(
    [claudeBinary(), "-p", prompt, "--model", opts.model, "--output-format", "json", "--system-prompt", RUBRIC,
      "--mcp-config", mcp, "--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true }),
      "--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent,TodoWrite,Skill,NotebookEdit,LS,MultiEdit"],
    { cwd: work, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
  const out = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(timer);
  rmSync(work, { recursive: true, force: true });
  try {
    const result = JSON.parse(out).result as string;
    const json = JSON.parse(result.slice(result.indexOf("{"), result.lastIndexOf("}") + 1));
    const verdict = ["pass", "fail", "impossible"].includes(json.verdict) ? json.verdict : "error";
    return { verdict, reason: String(json.reason ?? "") };
  } catch {
    return { verdict: "error", reason: `judge output could not be read: ${out.slice(0, 200)}` };
  }
}
