/** The agent loop: model turn, tool calls with permission checks, results back, until done. */

import type { Browser } from "../browser/browser";
import type { Effort, Message, Model, ToolCall, TurnRequest } from "../models/types";
import type { AuditLog } from "./audit";
import { classify, needsApproval, type Kind, type Mode, type SiteRule, type Target } from "./permissions";
import { systemPrompt } from "./prompt";
import { approvalDetail, checkCall, describeTarget, focusedTarget, liveTarget, newToolContext, pageContext, runTool, TOOL_SPECS, type ToolContext } from "./tools";

export type ApprovalRequest = { call: ToolCall; target?: Target; kind: Kind; site: string; summary: string };

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
  client?: string;
  effort?: Effort;
  siteRule?: (host: string) => SiteRule | undefined;
  signal?: AbortSignal;
};

const DEFAULT_MAX_STEPS = 40;
const DECLINED = "The user declined this action. Do not try it again; ask or finish.";

export async function* runTask(opts: TaskOptions): AsyncIterable<StepEvent> {
  const ctx = await newToolContext(opts.browser);
  const messages: Message[] = [{ role: "user", text: opts.task }];
  const signal = opts.signal ?? new AbortController().signal;
  const system = systemPrompt({ mode: opts.mode, now: new Date() });
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  try {
    for (let step = 0; step < maxSteps; step++) {
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
        const outcome = yield* act(ctx, opts, call);
        if (signal.aborted) {
          yield { type: "error", message: "Cancelled." };
          return;
        }
        if (outcome.final !== undefined) {
          yield { type: "final", text: outcome.final };
          return;
        }
        messages.push(outcome.message);
      }
    }
    yield { type: "error", message: `Stopped after ${maxSteps} steps without finishing. Ask again with more detail, or raise the step limit.` };
  } finally {
    await ctx.close();
  }
}

type Outcome = { final?: string; message: Extract<Message, { role: "tool" }> };

const READS = new Set(["navigate", "snapshot", "screenshot", "scroll", "hover", "wait_for", "back", "tabs", "open_tab", "switch_tab", "done", "repl"]);

async function* act(ctx: ToolContext, opts: TaskOptions, call: ToolCall): AsyncGenerator<StepEvent, Outcome> {
  const reply = (content: string, image?: string): Outcome => ({ message: { role: "tool", callId: call.id, name: call.name, content, image } });
  // A call that cannot run is answered at once: no approval prompt for something that would fail.
  const problem = checkCall(call);
  if (problem) return reply(problem);

  const target = call.name === "press" ? await focusedTarget(ctx) : describeTarget(ctx, call) ?? (await liveTarget(ctx, call));
  const page = READS.has(call.name) ? {} : await pageContext(ctx);
  const kind = classify(call, target, page);
  const destination = call.name === "navigate" || call.name === "open_tab" ? String(call.args.url) : undefined;
  const site = destination ? hostOf(destination) : await currentHost(ctx);
  const decision = needsApproval(opts.mode, kind, opts.siteRule?.(site));
  const what = target ? `${target.role} "${target.name}"` : summarizeArgs(call);
  const detail = kind === "read" ? what : [what, await approvalDetail(ctx, call)].filter(Boolean).join(" ");
  const entry = { time: new Date().toISOString(), tab: ctx.tab?.id ?? "", site, url: destination, action: call.name, detail, client: opts.client ?? "sidebar" };

  if (decision === "block") {
    await opts.audit.append({ ...entry, approved: null, result: "blocked" });
    return reply(`Blocked: the user does not allow the agent to act on ${site}.`);
  }
  let approved: boolean | null = null;
  if (decision === "ask") {
    const request: ApprovalRequest = { call, target, kind, site, summary: `${verb(call)} ${detail} on ${site}` };
    yield { type: "approval", request };
    approved = await opts.approve(request);
    if (!approved) {
      await opts.audit.append({ ...entry, approved: false, result: "declined" });
      return reply(DECLINED);
    }
  }
  const result = await runTool(ctx, call);
  await opts.audit.append({ ...entry, approved, result: result.isError ? "error" : "ok" });
  if (result.done) return { final: result.content, message: reply(result.content).message };
  if (!result.isError) yield { type: "step", label: label(call, target, site) };
  return reply(result.content, result.image);
}

function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

async function currentHost(ctx: ToolContext): Promise<string> {
  const url = ctx.tab ? await ctx.tab.url().catch(() => "") : "";
  try {
    return new URL(url).hostname || "a new tab";
  } catch {
    return "a new tab";
  }
}

function verb(call: ToolCall): string {
  return ({ click: "Click", type: "Type into", select: "Choose in", press: `Press ${call.args.key} in`, upload: "Upload to", click_at: "Click", repl: "Run a script" } as Record<string, string>)[call.name] ?? call.name;
}

function summarizeArgs(call: ToolCall): string {
  if (call.name === "click_at") return `the point ${call.args.x}, ${call.args.y}`;
  if (call.name === "repl") return `(${String(call.args.code ?? "").length} characters of code)`;
  return "";
}

function label(call: ToolCall, target: Target | undefined, site: string): string {
  const what = target ? `${target.role} "${target.name}"` : "";
  switch (call.name) {
    case "navigate":
    case "open_tab":
      try {
        return `Opened ${new URL(/^[a-z]+:\/\//i.test(String(call.args.url)) ? String(call.args.url) : `https://${call.args.url}`).hostname}`;
      } catch {
        return `Opened ${call.args.url}`;
      }
    case "click": return `Clicked ${what}`;
    case "type": return `Typed into ${what}`;
    case "select": return `Chose "${call.args.value}" in ${what}`;
    case "press": return `Pressed ${call.args.key}`;
    case "scroll": return "Scrolled";
    case "hover": return `Pointed at ${what}`;
    case "upload": return `Attached ${(call.args.paths as string[]).length} file(s)`;
    case "back": return "Went back";
    case "snapshot": return `Read ${site}`;
    case "screenshot": return `Looked at ${site}`;
    case "click_at": return `Clicked at ${call.args.x}, ${call.args.y}`;
    case "repl": return `Ran a script on ${site}`;
    case "wait_for": return `Waited for "${call.args.text}"`;
    case "tabs": return "Listed tabs";
    case "switch_tab": return "Switched tabs";
    default: return call.name;
  }
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
