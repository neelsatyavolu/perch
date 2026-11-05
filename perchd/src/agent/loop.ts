/** The agent loop: model turn, tool calls with permission checks, results back, until done. */

import type { Browser } from "../browser/browser";
import type { Effort, Message, Model, ToolCall, TurnRequest } from "../models/types";
import type { AuditLog } from "./audit";
import type { Mode, SiteRule } from "./permissions";
import { finalTurn } from "./finish";
import { Progress } from "./progress";
import { systemPrompt } from "./prompt";
import { finishCall, label, prepareCall, type ApprovalRequest } from "./session";
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
  audit: AuditLog;
  maxSteps?: number;
  /** Wall-clock budget; when it runs out the model gives its best answer. */
  maxMs?: number;
  client?: string;
  effort?: Effort;
  siteRule?: (host: string) => SiteRule | undefined;
  signal?: AbortSignal;
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
  const ctx = await newToolContext(opts.browser);
  const messages: Message[] = [{ role: "user", text: opts.task }];
  const signal = opts.signal ?? new AbortController().signal;
  const system = systemPrompt({ mode: opts.mode, now: new Date() });
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const progress = new Progress({ maxSteps, maxMs: opts.maxMs ?? DEFAULT_MAX_MS });
  let worked = false;
  let checked = false;
  try {
    for (let step = 0; step < maxSteps && !progress.timeUp(); step++) {
      let text = "";
      const calls: ToolCall[] = [];
      try {
        const req: TurnRequest = { system, messages: compact(messages), tools: TOOL_SPECS, effort: opts.effort };
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
        if (progress.timeUp()) {
          // Every call needs a result; the final turn follows.
          messages.push({ role: "tool", callId: call.id, name: call.name, content: TIME_UP });
          continue;
        }
        const outcome = yield* act(ctx, opts, call);
        if (signal.aborted) {
          yield { type: "error", message: "Cancelled." };
          return;
        }
        if (outcome.final !== undefined && worked && !checked && step < maxSteps - 1) {
          checked = true;
          messages.push({ ...outcome.message, content: CHECK_BEFORE_DONE });
          continue;
        }
        if (outcome.final !== undefined) {
          yield { type: "final", text: outcome.final };
          return;
        }
        worked = true;
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
    if (answer) {
      yield { type: "final", text: answer };
      return;
    }
    const limit = why === "time" ? "the time limit" : `${maxSteps} steps`;
    yield { type: "error", message: `Stopped after ${limit} without finishing. Ask again with more detail, or raise the limit.` };
  } finally {
    await ctx.close();
  }
}

type Outcome = { final?: string; message: Extract<Message, { role: "tool" }> };

async function* act(ctx: ToolContext, opts: TaskOptions, call: ToolCall): AsyncGenerator<StepEvent, Outcome> {
  const reply = (content: string, image?: string): Outcome => ({ message: { role: "tool", callId: call.id, name: call.name, content, image } });
  const prepared = await prepareCall(ctx, opts, call);
  if (prepared.kind === "answer") return reply(prepared.result.content);
  let approved: boolean | null = null;
  if (prepared.decision === "ask") {
    yield { type: "approval", request: prepared.request };
    approved = await opts.approve(prepared.request);
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
