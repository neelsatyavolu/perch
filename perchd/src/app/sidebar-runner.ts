/**
 * Runs a sidebar chat's task with the user's own outside agent: Codex (their ChatGPT sign-in) or
 * Claude Code (their Claude sign-in), the same way the benchmarks run them. The agent drives the
 * browser the user is looking at through `perch mcp` and perchd's socket, in a session of its own
 * that carries the chat's permission mode and sends approvals to the sidebar's card.
 */

import type { SkillCatalog } from "../skills/catalog";
import { sidebarExtras, type SidebarExtras } from "./sidebar-extras";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { StepEvent } from "../agent/loop";
import { clip, OUTPUT_LIMIT, stepDetail } from "../agent/steps";
import type { MemoryAccess } from "../memory/agent";
import { CHAT_SESSION_PREFIX, SIDEBAR_CLIENT, type SidebarRun } from "../daemon/server";
import { claudeBinary, codexBinary, runClaudeCode, runCodex, type AsideEvent, type McpServer } from "../external";
import { AGENT_OFF, agentAllowed, allowsModel, capMode, MODEL_NOT_ALLOWED, type Policy, type PolicyView } from "../policy/policy";
import { catalogEfforts } from "./effort";
import type { ModelInfo } from "./protocol";
import { bundledModels, type ModelCatalog } from "@neelsatyavolu/shared-ai-auth";
import type { Runner, RunnerInput } from "./runs";
import type { Mode } from "../agent/permissions";

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


function installed(agent: Agent): boolean {
  try {
    return existsSync(agent === "codex" ? codexBinary() : claudeBinary());
  } catch {
    return false;
  }
}

/**
 * The chat models, from shared-ai-auth's catalog: Codex and Claude Code when installed (they run
 * whole tasks), and the Claude and Grok sign-ins Perch calls itself. `signedIn` names the
 * subscriptions signed in now.
 */
export function sidebarModels(catalog: ModelCatalog = bundledModels, signedIn: readonly ("claude" | "grok")[] = [], has: (agent: Agent) => boolean = installed): ModelInfo[] {
  const claude = catalog.claude ?? bundledModels.claude ?? [];
  const list = (prefix: string, provider: string, models: readonly { id: string; label: string; efforts?: string[] }[]) =>
    models.map((m) => ({ id: `${prefix}:${m.id}`, label: m.label, provider, efforts: catalogEfforts(m.efforts) }));
  // Codex's own default model takes what its first catalog model takes.
  const codexDefault = { id: "codex:default", label: "Codex default", provider: "Codex", efforts: catalogEfforts(catalog.codex[0]?.efforts) };
  return [
    ...(has("codex") ? [...list("codex", "Codex", catalog.codex), codexDefault] : []),
    ...(signedIn.includes("claude") ? list("claude", "Claude", claude) : []),
    ...(has("claude-code") ? list("claude-code", "Claude Code", claude) : []),
    ...(signedIn.includes("grok") ? list("grok", "Grok", catalog.grok) : []),
  ];
}

const STEP_NAMES: Record<string, string> = {
  snapshot: "Read the page",
  screenshot: "Look at the page",
  repl: "Run a script on the page",
  tabs: "List open tabs",
  switch_tab: "Switch tabs",
  back: "Go back",
  scroll: "Scroll",
  type_text: "Type",
  save_pdf: "Save the page as a PDF",
  downloads: "Check downloads",
  load_skill: "Read a skill",
  memory_search: "Search memory",
  memory_save: "Save to memory",
  read_attachment: "Read an attachment",
  schedule_message: "Schedule a message",
};

const quoted = (value: unknown, max = 40) => (typeof value === "string" && value.trim() ? ` "${value.trim().length > max ? `${value.trim().slice(0, max)}…` : value.trim()}"` : "");

const host = (url: string): string | null => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch {
    return null;
  }
};

/** "WebSearch" → "Web search", "switch_tab" → "Switch tab". */
function words(tool: string): string {
  const spaced = tool.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A short line for the chat's step list, like "Open example.com" or "Press Enter". What is typed is never shown. */
export function stepLabel(tool: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  // The model's own few words on what a script or batch is for beat a generic name.
  if (typeof a.title === "string" && a.title.trim()) {
    const t = a.title.trim().replace(/\s+/g, " ");
    return t.length > 60 ? `${t.slice(0, 59)}…` : t;
  }
  if (STEP_NAMES[tool]) return STEP_NAMES[tool];
  if (tool === "WebSearch") return typeof a.query === "string" && a.query.trim() ? `Search the web for${quoted(a.query, 60)}` : "Search the web";
  if (tool === "WebFetch") return typeof a.url === "string" && host(a.url) ? `Read ${host(a.url)}` : "Read a web page";
  if (tool === "batch" && Array.isArray(a.actions)) return `Do ${a.actions.length} actions`;
  if (tool === "press" && typeof a.key === "string") return `Press ${a.key}`;
  if (tool === "wait_for") return a.text ? `Wait for${quoted(a.text)}` : "Wait";
  if (tool === "select") return `Choose${quoted(a.value)}`;
  const verb = words(tool);
  if (typeof a.url === "string") {
    const h = host(a.url);
    return h ? `${tool === "navigate" || tool === "open_tab" ? "Open" : verb} ${h}` : verb;
  }
  return verb;
}

/** What the chat shows while the agent works: each tool call as a step, its result, and what the agent says between them. */
export function toStep(event: AsideEvent): StepEvent | null {
  if (event.type === "tool_execution_start") {
    const detail = stepDetail(event.toolName, event.args);
    return { type: "step", label: stepLabel(event.toolName, event.args), ...(detail ? { detail } : {}) };
  }
  if (event.type === "message_end" && event.message.role === "toolResult") {
    const output = event.message.content.map((c) => c.text).join("\n").trim();
    return output ? { type: "step_output", output: clip(output, OUTPUT_LIMIT) } : null;
  }
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
  /**
   * Perch's own agent loop, for a model Perch calls directly (a Claude sign-in, an API key)
   * rather than through a CLI. It works in the chat's daemon session, so tabs group and stay the same.
   */
  ownLoop?: OwnLoop;
};

export type OwnLoop = (run: {
  input: RunnerInput;
  provider: string;
  model: string;
  /** The chat's daemon session id, as a CLI agent's would be. */
  session: string;
  mode: Mode;
  memory?: MemoryAccess;
  extras?: SidebarExtras;
}) => AsyncIterable<StepEvent>;

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
      if (!opts.ownLoop || !agent || !model) {
        yield { type: "error", message: "Pick a model for this chat in its model menu." };
        return;
      }
      yield* runOwnLoop(opts, opts.ownLoop, input, agent, model);
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
    // One session per chat, so a follow-up continues in the tabs the last turn opened. A private
    // chat's tabs never outlive its turn.
    const session = input.chatId && !input.incognito ? `${CHAT_SESSION_PREFIX}${input.chatId}` : `sidebar-${randomBytes(12).toString("hex")}`;
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
      effort: input.settings.effort,
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

/** A chat on a model Perch calls itself: the same session, memory, skills and policy as a CLI agent gets. */
async function* runOwnLoop(opts: SidebarRunnerOptions, ownLoop: OwnLoop, input: RunnerInput, provider: string, model: string): AsyncIterable<StepEvent> {
  const policy = opts.policy?.current() ?? {};
  const refused = sidebarRefusal(provider, model, policy);
  if (refused) {
    yield { type: "error", message: refused };
    return;
  }
  const memory = input.incognito ? undefined : await opts.memory?.().catch(() => undefined);
  const catalog = await opts.skills?.().catch(() => undefined);
  const extras = sidebarExtras(catalog, memory, input.files, input.incognito ? undefined : input.schedule);
  const session = input.chatId && !input.incognito ? `${CHAT_SESSION_PREFIX}${input.chatId}` : `sidebar-${randomBytes(12).toString("hex")}`;
  const mode = capMode(input.settings.mode, policy);
  // Registered like a CLI agent's run, so the perch dot and the live thumbnail find its tabs.
  opts.runs.add(session, { token: randomBytes(32).toString("base64url"), mode, approve: input.approve, ...(input.chatId ? { chatId: input.chatId } : {}), ...(input.incognito ? { private: true } : {}) });
  try {
    yield* ownLoop({ input, provider, model, session, mode, ...(memory ? { memory } : {}), ...(extras ? { extras } : {}) });
  } finally {
    opts.runs.delete(session);
  }
}
