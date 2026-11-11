/** The agent loop: model turn, tool calls with permission checks, results back, until done. */

import { agentToolSpecs } from "../apps/index";
import type { Browser } from "../browser/browser";
import { actExtra, type ExtraTools } from "../mcp-client/extra-tools";
import { memoryCall, type MemoryAccess } from "../memory/agent";
import type { Effort, Message, Model, ToolCall, TurnRequest } from "../models/types";
import { AGENT_OFF, agentAllowed, capMode, siteRuleFor, type PolicyView } from "../policy/policy";
import type { AuditWriter } from "./audit";
import type { Mode, SiteRule } from "./permissions";
import { finalTurn } from "./finish";
import { Progress } from "./progress";
import { systemPrompt } from "./prompt";
import { BATCH, callTool, finishCall, label, prepareCall, type ApprovalRequest } from "./session";
import { SCRIPT } from "./script";
import { newToolContext, TOOL_SPECS, type ToolContext } from "./tools";

export type { ApprovalRequest } from "./session";

export type StepEvent =
  | { type: "step"; label: string }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "text"; delta: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

export type TaskOptions = {
  model: Model;
  browser: Browser;
  task: string;
  mode: Mode;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  audit: AuditWriter;
  maxSteps?: number;
  /** Wall-clock budget; when it runs out the model gives its best answer. */
  maxMs?: number;
  client?: string;
  effort?: Effort;
  siteRule?: (host: string) => SiteRule | undefined;
  signal?: AbortSignal;
  /** MCP server tools and skills, run under the same permission mode and audit log. */
  extraTools?: ExtraTools;
  /** The chat's memory (src/memory/agent.ts). Left out for incognito chats. */
  memory?: MemoryAccess;
  /** Company policy (spec 12.2), read again before every action so a change applies mid-chat. */
  policy?: PolicyView;
};

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_MAX_MS = 15 * 60_000;
const TIME_UP = "Not run: the time for this task is up.";

/** Sent once, in place of the first done after the agent has used the browser. */
export const CHECK_BEFORE_DONE = [
  "Before you finish, check your answer against the task, one requirement at a time:",
  "- Did a page you opened in this task show each fact? Anything guessed or from memory is not done yet: open the page that has it now.",
  "- Did you apply every filter, collect every item, and finish every step the task asks for?",
  "If something is missing, keep working. If everything is backed by pages, call done again with your answer (corrected if needed).",
].join("\n");

export async function* runTask(opts: TaskOptions): AsyncIterable<StepEvent> {
  if (opts.policy && !agentAllowed(opts.policy.current())) {
    yield { type: "error", message: AGENT_OFF };
    return;
  }
  const ctx = await newToolContext(opts.browser);
  const messages: Message[] = [{ role: "user", text: opts.task }];
  const signal = opts.signal ?? new AbortController().signal;
  const extraPrompt = opts.extraTools?.prompt() ?? "";
  const remembered = opts.memory ? await opts.memory.context(opts.task).catch(() => "") : "";
  const system = [systemPrompt({ mode: opts.mode, now: new Date() }), extraPrompt, remembered].filter(Boolean).join("\n\n");
  const tools = [...agentToolSpecs(TOOL_SPECS), ...(opts.extraTools?.specs() ?? []), ...(opts.memory?.specs ?? [])];
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const progress = new Progress({ maxSteps, maxMs: opts.maxMs ?? DEFAULT_MAX_MS });
  let worked = false;
  let checked = false;
  /** The answer of a done that was sent back for checking: kept in case no better one comes. */
  let draft: string | undefined;
  try {
    for (let step = 0; step < maxSteps && !progress.timeUp(); step++) {
      let text = "";
      const calls: ToolCall[] = [];
      try {
        const req: TurnRequest = { system, messages: compact(messages), tools, effort: opts.effort };
        for await (const event of opts.model.turn(req, signal)) {
          if (event.type === "text") {
            text += event.delta;
            yield event;
          } else if (event.type === "tool_call") calls.push(event.call);
        }
      } catch (error) {
        yield { type: "error", message: error instanceof Error ? error.message : String(error) };
        return;
      }
      messages.push({ role: "assistant", text, toolCalls: calls });
      if (calls.length === 0) {
        yield { type: "final", text: text.trim() };
        return;
      }
      for (const call of calls) {
        if (signal.aborted) {
          yield { type: "error", message: "Cancelled." };
          return;
        }
        // A done still counts once time is up: it is the answer the final turn would ask for.
        if (progress.timeUp() && call.name !== "done") {
          // Every call needs a result; the final turn follows.
          messages.push({ role: "tool", callId: call.id, name: call.name, content: TIME_UP });
          continue;
        }
        if (opts.policy && !agentAllowed(opts.policy.current())) {
          yield { type: "error", message: AGENT_OFF };
          return;
        }
        const outcome = yield* act(ctx, opts, call, progress);
        if (signal.aborted) {
          yield { type: "error", message: "Cancelled." };
          return;
        }
        if (outcome.final !== undefined && worked && !checked && step < maxSteps - 1 && !progress.timeUp()) {
          checked = true;
          draft = outcome.final;
          messages.push({ ...outcome.message, content: CHECK_BEFORE_DONE });
          continue;
        }
        if (outcome.final !== undefined) {
          yield { type: "final", text: outcome.final };
          return;
        }
        if (!opts.memory?.handles(call.name)) worked = true;
        const notes = progress.after(call, outcome.message.content);
        messages.push(notes.length ? { ...outcome.message, content: `${notes.join("\n")}\n\n${outcome.message.content}` } : outcome.message);
      }
    }
    if (signal.aborted) {
      yield { type: "error", message: "Cancelled." };
      return;
    }
    const why = progress.timeUp() ? "time" : "steps";
    const answer = yield* finalTurn({ model: opts.model, system, messages: compact(messages), tools: TOOL_SPECS, why, effort: opts.effort, signal });
    if (answer || draft) {
      yield { type: "final", text: answer || draft! };
      return;
    }
    const limit = why === "time" ? "the time limit" : `${maxSteps} steps`;
    yield { type: "error", message: `Stopped after ${limit} without finishing. Ask again with more detail, or raise the limit.` };
  } finally {
    await ctx.close();
    opts.memory?.chatEnded(messages);
  }
}

type Outcome = { final?: string; message: Extract<Message, { role: "tool" }> };

/**
 * The task's rules for its next action under the current company policy: the mode lowered to the
 * cap, and the company's site rules over the person's.
 */
export function governed(opts: TaskOptions): TaskOptions {
  if (!opts.policy) return opts;
  const policy = opts.policy.current();
  const own = opts.siteRule;
  return { ...opts, mode: capMode(opts.mode, policy), siteRule: (host) => siteRuleFor(host, own?.(host), policy) };
}

async function* act(ctx: ToolContext, task: TaskOptions, call: ToolCall, progress: Progress): AsyncGenerator<StepEvent, Outcome> {
  const opts = governed(task);
  const reply = (content: string, image?: string): Outcome => ({ message: { role: "tool", callId: call.id, name: call.name, content, image } });
  if (opts.extraTools?.handles(call.name)) {
    const result = yield* actExtra(opts, opts.extraTools, call, opts.signal ?? new AbortController().signal);
    return reply(result.content, result.image);
  }
  if (opts.memory?.handles(call.name)) return reply((yield* memoryCall(opts.memory, opts, call)).content);
  // Batches and scripts run each action through callTool, which asks for approval as it goes.
  if (call.name === BATCH || call.name === SCRIPT) {
    const result = await callTool(ctx, opts, call);
    if (!result.isError) yield { type: "step", label: call.name === SCRIPT ? "Run a script" : "Run several actions" };
    return reply(result.content, result.image);
  }
  const prepared = await prepareCall(ctx, opts, call);
  if (prepared.kind === "answer") return reply(prepared.result.content);
  let approved: boolean | null = null;
  if (prepared.decision === "ask") {
    yield { type: "approval", request: prepared.request };
    // The user's thinking time is not the agent's: the time budget waits with them.
    approved = await progress.whilePaused(() => opts.approve(prepared.request));
  }
  const result = await finishCall(ctx, opts, prepared, approved);
  if (result.done) return { final: result.content, message: reply(result.content).message };
  if (!result.isError && approved !== false) yield { type: "step", label: label(call, prepared.target, prepared.site) };
  return reply(result.content, result.image);
}

/** Keeps only the newest page snapshot and screenshot in full; older ones become one line. */
export function compact(messages: Message[]): Message[] {
  const isPage = (m: Message) => m.role === "tool" && /(^|\n)Page: /.test(m.content);
  const lastPage = messages.findLastIndex(isPage);
  const lastImage = messages.findLastIndex((m) => m.role !== "assistant" && Boolean(m.image));
  return messages.map((m, i) => {
    if (m.role !== "tool") return m;
    let next = m;
    if (isPage(m) && i !== lastPage) {
      const url = m.content.match(/(?:^|\n)Page: .*\((.*)\)\n/)?.[1] ?? "the page";
      const lines = m.content.split("\n").length;
      const note = m.content.split(/\n\nPage: |^Page: /)[0]?.trim();
      next = { ...next, content: `${note ? `${note}\n` : ""}[older page snapshot of ${url}, ${lines} lines]` };
    }
    if (next.image && i !== lastImage) next = { ...next, image: undefined, content: `${next.content}\n[older screenshot removed]` };
    return next;
  });
}
