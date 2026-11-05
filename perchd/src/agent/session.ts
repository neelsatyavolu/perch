/**
 * One tool call under Perch's rules: checked, classified, approved if needed, run and audited.
 * Shared by the task loop (sidebar chats) and the MCP server (outside agents).
 */

import type { ToolCall } from "../models/types";
import type { AuditLog } from "./audit";
import { classify, needsApproval, type Kind, type Mode, type SiteRule, type Target } from "./permissions";
import { approvalDetail, checkCall, describeTarget, focusedTarget, liveTarget, pageContext, runTool, type ToolContext, type ToolResult } from "./tools";

export type ApprovalRequest = { call: ToolCall; target?: Target; kind: Kind; site: string; summary: string };

export type CallPolicy = {
  mode: Mode;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  audit: AuditLog;
  client?: string;
  siteRule?: (host: string) => SiteRule | undefined;
};

export const DECLINED = "The user declined this action. Do not try it again; ask or finish.";

export type Prepared =
  | { kind: "answer"; result: ToolResult }
  | { kind: "run"; call: ToolCall; target?: Target; site: string; decision: "run" | "ask"; request: ApprovalRequest; entry: Omit<import("./audit").AuditEntry, "approved" | "result"> };

const READS = new Set(["navigate", "snapshot", "screenshot", "scroll", "hover", "wait_for", "back", "tabs", "open_tab", "switch_tab", "done", "repl"]);

/** Checks and classifies a call. Calls that cannot run, or are blocked, are answered here. */
export async function prepareCall(ctx: ToolContext, opts: CallPolicy, call: ToolCall): Promise<Prepared> {
  // A call that cannot run is answered at once: no approval prompt for something that would fail.
  const problem = checkCall(call);
  if (problem) return { kind: "answer", result: { content: problem, isError: true } };

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
    return { kind: "answer", result: { content: `Blocked: the user does not allow the agent to act on ${site}.`, isError: true } };
  }
  const request: ApprovalRequest = { call, target, kind, site, summary: `${verb(call)} ${detail} on ${site}` };
  return { kind: "run", call, target, site, decision, request, entry };
}

/** Runs a prepared call after the approval decision (null when none was needed) and audits it. */
export async function finishCall(ctx: ToolContext, opts: CallPolicy, prepared: Extract<Prepared, { kind: "run" }>, approved: boolean | null): Promise<ToolResult> {
  if (approved === false) {
    await opts.audit.append({ ...prepared.entry, approved: false, result: "declined" });
    return { content: DECLINED, isError: true };
  }
  const result = await runTool(ctx, prepared.call);
  await opts.audit.append({ ...prepared.entry, approved, result: result.isError ? "error" : "ok" });
  return result;
}

/** prepareCall, the approval if needed, and finishCall in one step: for clients without a UI loop. */
export async function callTool(ctx: ToolContext, opts: CallPolicy, call: ToolCall): Promise<ToolResult> {
  const prepared = await prepareCall(ctx, opts, call);
  if (prepared.kind === "answer") return prepared.result;
  const approved = prepared.decision === "ask" ? await opts.approve(prepared.request) : null;
  return finishCall(ctx, opts, prepared, approved);
}

function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

export async function currentHost(ctx: ToolContext): Promise<string> {
  const url = ctx.tab ? await ctx.tab.url().catch(() => "") : "";
  try {
    return new URL(url).hostname || "a new tab";
  } catch {
    return "a new tab";
  }
}

function verb(call: ToolCall): string {
  return ({ click: "Click", type: "Type into", select: "Choose in", press: `Press ${call.args.key} in`, upload: "Upload to", drag: "Drag", click_at: "Click", repl: "Run a script" } as Record<string, string>)[call.name] ?? call.name;
}

function summarizeArgs(call: ToolCall): string {
  if (call.name === "click_at") return `the point ${call.args.x}, ${call.args.y}`;
  if (call.name === "repl") return `(${String(call.args.code ?? "").length} characters of code)`;
  return "";
}

export function label(call: ToolCall, target: Target | undefined, site: string): string {
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
    case "drag": return `Dragged ${what}`;
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

