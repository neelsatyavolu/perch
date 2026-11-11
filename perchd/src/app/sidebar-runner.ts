/**
 * Runs a sidebar chat's task with the user's own outside agent: Codex (their ChatGPT sign-in) or
 * Claude Code (their Claude sign-in), the same way the benchmarks run them. The agent drives the
 * browser the user is looking at through `perch mcp` and perchd's socket, in a session of its own
 * that carries the chat's permission mode and sends approvals to the sidebar's card.
 */

import type { SkillCatalog } from "../skills/catalog";
import { sidebarExtras } from "./sidebar-extras";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { StepEvent } from "../agent/loop";
import type { MemoryAccess } from "../memory/agent";
import { SIDEBAR_CLIENT, type SidebarRun } from "../daemon/server";
import { claudeBinary, codexBinary, runClaudeCode, runCodex, type AsideEvent, type McpServer } from "../external";
import { AGENT_OFF, agentAllowed, allowsModel, capMode, MODEL_NOT_ALLOWED, type Policy, type PolicyView } from "../policy/policy";
import type { ModelInfo } from "./protocol";
import type { Runner } from "./runs";

/** The sidebar runs in progress, by their daemon session id. */
export class SidebarRuns {
  private readonly runs = new Map<string, SidebarRun>();

  get(session: string): SidebarRun | undefined {
    return this.runs.get(session);
  }

  add(session: string, run: SidebarRun): void {
    this.runs.set(session, run);
  }

  delete(session: string): void {
    this.runs.delete(session);
  }

  /** The daemon sessions working for a chat now. */
  sessionsFor(chatId: string): string[] {
    return [...this.runs].filter(([, run]) => run.chatId === chatId).map(([session]) => session);
  }
}

type Agent = "codex" | "claude-code";

const MODELS: (ModelInfo & { agent: Agent })[] = [
  { agent: "codex", id: "codex:gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "Codex", efforts: ["low", "medium", "high"] },
  { agent: "codex", id: "codex:default", label: "Codex default", provider: "Codex", efforts: ["low", "medium", "high"] },
  { agent: "claude-code", id: "claude-code:claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "Claude Code", efforts: ["medium"] },
  { agent: "claude-code", id: "claude-code:claude-opus-5-5", label: "Claude Opus 5.5", provider: "Claude Code", efforts: ["medium"] },
];

function installed(agent: Agent): boolean {
  try {
    return existsSync(agent === "codex" ? codexBinary() : claudeBinary());
  } catch {
    return false;
  }
}

/** The models of the outside agents installed on this Mac. */
export function sidebarModels(): ModelInfo[] {
  const have = new Set((["codex", "claude-code"] as Agent[]).filter(installed));
  return MODELS.filter((m) => have.has(m.agent)).map(({ agent: _agent, ...info }) => info);
}

const STEP_NAMES: Record<string, string> = {
  snapshot: "Read the page",
  screenshot: "Look at the page",
  repl: "Run a script on the page",
  tabs: "List open tabs",
  switch_tab: "Switch tabs",
  back: "Go back",
  scroll: "Scroll",
};

const quoted = (value: unknown, max = 40) => (typeof value === "string" && value.trim() ? ` "${value.trim().length > max ? `${value.trim().slice(0, max)}…` : value.trim()}"` : "");

/** A short line for the chat's step list, like "Open example.com" or "Press Enter". What is typed is never shown. */
export function stepLabel(tool: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const name = tool.replace(/_/g, " ");
  const verb = name.charAt(0).toUpperCase() + name.slice(1);
  if (STEP_NAMES[tool]) return STEP_NAMES[tool];
  if (tool === "press" && typeof a.key === "string") return `Press ${a.key}`;
  if (tool === "wait_for") return a.text ? `Wait for${quoted(a.text)}` : "Wait";
  if (tool === "select") return `Choose${quoted(a.value)}`;
  if (typeof a.url === "string") {
    try {
      return `${tool === "navigate" || tool === "open_tab" ? "Open" : verb} ${new URL(a.url.includes("://") ? a.url : `https://${a.url}`).host}`;
    } catch {
      return verb;
    }
  }
  if (tool === "type" && typeof a.text === "string") return "Type";
  return verb;
}

/** What the chat shows while the agent works: each tool call as a step, and what the agent says between them. */
function toStep(event: AsideEvent): StepEvent | null {
  if (event.type === "tool_execution_start") return { type: "step", label: stepLabel(event.toolName, event.args) };
  if (event.type === "message_end" && event.message.role === "assistant") {
    const said = event.message.content.map((c) => c.text).join("\n").trim();
    if (said) return { type: "text", delta: `${said}\n\n` };
  }
  return null;
}

export type SidebarRunnerOptions = {
  runs: SidebarRuns;
  /** How to start `perch mcp`: this perchd binary, or bun with the CLI's source in development. */
  perch: { command: string; args: string[] };
  /** PERCH_HOME for the agent's `perch mcp`, so it reaches this perchd's socket. */
  home: string;
  auditPath: string;
  timeoutMs?: number;
  /** The profile's memory for this chat: what Perch knows goes in with the task, and facts are learned from the answer. */
  memory?: () => Promise<MemoryAccess | undefined>;
  /** The profile's skills, offered to the agent through load_skill. */
  skills?: () => Promise<SkillCatalog | undefined>;
  /** Company policy: the agent on or off, allowed models, and the mode cap. */
  policy?: PolicyView;
};

/** Why a chat on this model cannot start under the company policy, or null when it can. */
export function sidebarRefusal(agent: string, model: string, policy: Policy): string | null {
  if (!agentAllowed(policy)) return AGENT_OFF;
  return allowsModel(agent, model, policy) ? null : MODEL_NOT_ALLOWED;
}

/** The sidebar's models the company policy allows. */
export function allowedSidebarModels(models: readonly ModelInfo[], policy: Policy): ModelInfo[] {
  return models.filter((m) => {
    const [agent = "", ...rest] = m.id.split(":");
    return allowsModel(agent, rest.join(":"), policy);
  });
}

export function sidebarRunner(opts: SidebarRunnerOptions): Runner {
  return async function* (input): AsyncIterable<StepEvent> {
    const [agent, ...rest] = input.settings.model.split(":");
    const model = rest.join(":");
    if (agent !== "codex" && agent !== "claude-code") {
      yield { type: "error", message: "Pick Codex or Claude Code as the model for this chat." };
      return;
    }
    const policy = opts.policy?.current() ?? {};
    const refused = sidebarRefusal(agent, model, policy);
    if (refused) {
      yield { type: "error", message: refused };
      return;
    }
    // A private chat (spec 5.8) neither reads nor teaches memory.
    const memory = input.incognito ? undefined : await opts.memory?.().catch(() => undefined);
    const known = memory ? await memory.context(input.ask ?? input.task).catch(() => "") : "";
    const session = `sidebar-${randomBytes(12).toString("hex")}`;
    const token = randomBytes(32).toString("base64url");
    const mode = capMode(input.settings.mode, policy);
    const catalog = await opts.skills?.().catch(() => undefined);
    const extras = sidebarExtras(catalog, memory, input.files, input.incognito ? undefined : input.schedule);
    const skillList = extras?.prompt() ?? "";
    opts.runs.add(session, {
      ...(extras ? { extras } : {}),
      token, mode, approve: input.approve,
      ...(input.tab?.targetId ? { tab: input.tab.targetId } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.incognito ? { private: true } : {}),
    });
    const mcp: McpServer = {
      command: opts.perch.command,
      args: [...opts.perch.args, "mcp", "--agent", "Perch", "--title", "Sidebar"],
      env: { PERCH_HOME: opts.home, PERCH_CLIENT: SIDEBAR_CLIENT, PERCH_SESSION: session, PERCH_TOKEN: token },
    };
    const queue: StepEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (event: StepEvent) => {
      queue.push(event);
      wake?.();
    };
    const run = agent === "codex" ? runCodex : runClaudeCode;
    const done = run({
      task: [input.task, known, skillList].filter(Boolean).join("\n\n"),
      model: model && model !== "default" ? model : undefined,
      effort: agent === "codex" ? input.settings.effort : undefined,
      mode,
      timeoutMs: opts.timeoutMs ?? 20 * 60_000,
      auditPath: opts.auditPath,
      mcp,
      signal: input.signal,
      onEvent: (event) => {
        const step = toStep(event);
        if (step) push(step);
      },
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    let finished: Awaited<typeof done> | null = null;
    void done.then((f) => {
      finished = f;
      wake?.();
    });
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (finished) break;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
      const f = finished as Awaited<typeof done>;
      if ("error" in f) {
        yield { type: "error", message: f.error };
      } else if (f.result.answer.trim()) {
        memory?.chatEnded([{ role: "user", text: input.ask ?? input.task }, { role: "assistant", text: f.result.answer.trim(), toolCalls: [] }]);
        yield { type: "final", text: f.result.answer.trim() };
      } else if (!input.signal.aborted) {
        const why = f.result.timedOut ? "it ran out of time" : `it stopped (exit ${f.result.exitCode})`;
        const detail = f.result.stderr.trim().split("\n").filter(Boolean).slice(-1)[0];
        yield { type: "error", message: `${agent === "codex" ? "Codex" : "Claude Code"} gave no answer: ${why}.${detail ? ` ${detail.slice(0, 300)}` : ""}` };
      }
    } finally {
      opts.runs.delete(session);
    }
  };
}
