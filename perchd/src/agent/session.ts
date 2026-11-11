/**
 * One tool call under Perch's rules: checked, classified, approved if needed, run and audited.
 * Shared by the task loop (sidebar chats) and the MCP server (outside agents).
 */

import { appTool } from "../apps/index";
import type { ToolCall } from "../models/types";
import type { AuditWriter } from "./audit";
import { FILL_TOOLS, fillKind, fillSummary } from "./fill-tools";
import { classify, needsApproval, type Kind, type Mode, type SiteRule, type Target } from "./permissions";
import { approvalDetail, checkCall, describeTarget, focusedTarget, liveTarget, pageContext, runTool, type ToolContext, type ToolResult } from "./tools";

export type ApprovalRequest = { call: ToolCall; target?: Target; kind: Kind; site: string; summary: string };

export type CallPolicy = {
  mode: Mode;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  audit: AuditWriter;
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
  const app = appTool(call.name);
  const fill = FILL_TOOLS.has(call.name);
  const page = READS.has(call.name) || app || fill ? {} : await pageContext(ctx);
  const drop = await dropTarget(ctx, call);
  const destination = call.name === "navigate" || call.name === "open_tab" ? String(call.args.url) : undefined;
  const site = app ? app.site : destination ? hostOf(destination) : await currentHost(ctx);
  const kind = fill ? fillKind(call.name, site, ctx) : classify(call, target, page, drop);
  const ruled = needsApproval(opts.mode, kind, opts.siteRule?.(site));
  const decision = ruled === "run" && app?.alwaysAsks(call.args) ? "ask" : ruled;
  const what = [target ? `${target.role} "${target.name}"` : summarizeArgs(call), drop ? `onto ${drop.role} "${drop.name}"` : ""].filter(Boolean).join(" ");
  const detail = kind === "read" ? what : [what, await approvalDetail(ctx, call)].filter(Boolean).join(" ");
  // The audit log holds what was typed or filled only when an approval card showed it to the
  // person; an action that ran without asking is logged by its target alone (Review Focus 4).
  const shown = decision === "ask" ? detail : what;
  const entry = { time: new Date().toISOString(), tab: ctx.tab?.id ?? "", site, url: destination, action: call.name, detail: shown, client: opts.client ?? "sidebar" };

  if (decision === "block") {
    await opts.audit.append({ ...entry, approved: null, result: "blocked" });
    return { kind: "answer", result: { content: `Blocked: the user does not allow the agent to act on ${site}.`, isError: true } };
  }
  // A fill's card names the login or card (masked); it goes to the user only, never into the audit detail or the model.
  const summary = fill ? (decision === "ask" ? await fillSummary(ctx, call.name, site) : "") : `${verb(call)} ${detail} on ${site}`;
  const request: ApprovalRequest = { call, target, kind, site, summary };
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
  if (call.name === BATCH) return callBatch(ctx, opts, call);
  const prepared = await prepareCall(ctx, opts, call);
  if (prepared.kind === "answer") return prepared.result;
  const approved = prepared.decision === "ask" ? await opts.approve(prepared.request) : null;
  return finishCall(ctx, opts, prepared, approved);
}

export const BATCH = "batch";
const BATCHABLE = new Set(["click", "type", "select", "press", "scroll", "hover", "drag", "type_text", "wait_for"]);
const MAX_BATCH = 10;

/**
 * Several actions in one call, to save a model turn each. Every action goes through callTool, so
 * each is checked, approved (or declined) and audited exactly as on its own. The batch stops at
 * the first error or decline and returns what that action returned, with what ran before it.
 */
async function callBatch(ctx: ToolContext, opts: CallPolicy, call: ToolCall): Promise<ToolResult> {
  const list = call.args.actions;
  if (!Array.isArray(list) || list.length === 0) return { content: "actions must be a list of { name, args }", isError: true };
  if (list.length > MAX_BATCH) return { content: `batch takes at most ${MAX_BATCH} actions`, isError: true };
  for (const [i, a] of list.entries()) {
    const name = (a as { name?: unknown })?.name;
    if (typeof name !== "string" || !BATCHABLE.has(name)) return { content: `action ${i + 1}: batch can run ${[...BATCHABLE].join(", ")}`, isError: true };
  }
  const done: string[] = [];
  let last: ToolResult = { content: "" };
  for (const [i, a] of list.entries()) {
    const { name, args } = a as { name: string; args?: unknown };
    const step: ToolCall = { id: `${call.id}.${i + 1}`, name, args: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {} };
    last = await callTool(ctx, opts, step);
    if (last.isError) {
      const before = done.length ? `Ran ${done.join(", ")}; then ` : "";
      return { ...last, content: `${before}action ${i + 1} (${name}) stopped the batch:\n${last.content}` };
    }
    done.push(name);
  }
  return { ...last, content: `Ran ${done.length} actions (${done.join(", ")}).\n\n${last.content}` };
}

/** For a drag onto an element: that element, from the last snapshot or read live. */
async function dropTarget(ctx: ToolContext, call: ToolCall): Promise<Target | undefined> {
  if (call.name !== "drag" || typeof call.args.to !== "string") return undefined;
  const onto = { ...call, args: { ref: call.args.to } };
  return describeTarget(ctx, onto) ?? (await liveTarget(ctx, onto));
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
  if (appTool(call.name)) return [call.args.command, ...((call.args.args as string[] | undefined) ?? [])].join(" ");
  if (call.name === "sign_in") return "a saved login";
  if (call.name === "fill_card") return "a saved card";
  if (call.name === "fill_code") return "an authenticator code";
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
    case "type_text": return "Typed text";
    case "save_pdf": return `Saved ${site} as a PDF`;
    case "downloads": return "Checked downloads";
    case "repl": return `Ran a script on ${site}`;
    case "wait_for": return `Waited for "${call.args.text}"`;
    case "tabs": return "Listed tabs";
    case "switch_tab": return "Switched tabs";
    case "sign_in": return `Signed in to ${site}`;
    case "fill_card": return `Filled a saved card on ${site}`;
    case "fill_code": return `Filled a code on ${site}`;
    default: return call.name;
  }
}

