/**
 * Tools beyond the browser's own (MCP servers, skills), run by the task loop under the same rules:
 * classified, approved when the mode asks for it, and written to the audit log.
 */

import type { AuditLog } from "../agent/audit";
import { needsApproval, type Kind, type Mode } from "../agent/permissions";
import { DECLINED, type ApprovalRequest } from "../agent/session";
import type { ToolResult } from "../agent/tools";
import type { ToolCall, ToolSpec } from "../models/types";

export type ExtraCall = {
  kind: Kind;
  /** Where the action goes, shown like a site: "mcp:github", "skills". */
  site: string;
  /** What an approval card shows. */
  summary: string;
  /** What the audit log records. */
  detail: string;
  /** The collapsed step line, such as "Used create_issue (github)". */
  label: string;
};

export type ExtraTools = {
  /** Read on every model turn, so servers that change their tools are picked up. */
  specs(): ToolSpec[];
  /** Added to the system prompt once per task. */
  prompt(): string;
  handles(name: string): boolean;
  /** A problem that means the call must not run, or null. */
  check(call: ToolCall): string | null;
  describe(call: ToolCall): ExtraCall;
  run(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
};

export type ExtraPolicy = { mode: Mode; approve: (request: ApprovalRequest) => Promise<boolean>; audit: AuditLog; client?: string };

export type ExtraEvent = { type: "approval"; request: ApprovalRequest } | { type: "step"; label: string };

export async function* actExtra(policy: ExtraPolicy, tools: ExtraTools, call: ToolCall, signal: AbortSignal): AsyncGenerator<ExtraEvent, ToolResult> {
  const problem = tools.check(call);
  if (problem) return { content: problem, isError: true };
  const d = tools.describe(call);
  const entry = { time: new Date().toISOString(), tab: "", site: d.site, action: call.name, detail: d.detail, client: policy.client ?? "sidebar" };
  const decision = needsApproval(policy.mode, d.kind);
  let approved: boolean | null = null;
  if (decision === "ask") {
    const request: ApprovalRequest = { call, kind: d.kind, site: d.site, summary: d.summary };
    yield { type: "approval", request };
    approved = await policy.approve(request);
    if (!approved) {
      await policy.audit.append({ ...entry, approved: false, result: "declined" });
      return { content: DECLINED, isError: true };
    }
  }
  let result: ToolResult;
  try {
    result = await tools.run(call, signal);
  } catch (error) {
    result = { content: error instanceof Error ? error.message : String(error), isError: true };
  }
  await policy.audit.append({ ...entry, approved, result: result.isError ? "error" : "ok" });
  if (!result.isError) yield { type: "step", label: d.label };
  return result;
}

/** Several providers as one; the first that handles a name wins. */
export function combineExtraTools(...list: (ExtraTools | undefined)[]): ExtraTools {
  const all = list.filter((t): t is ExtraTools => Boolean(t));
  const owner = (name: string) => all.find((t) => t.handles(name));
  return {
    specs: () => all.flatMap((t) => t.specs()),
    prompt: () => all.map((t) => t.prompt()).filter(Boolean).join("\n\n"),
    handles: (name) => Boolean(owner(name)),
    check: (call) => owner(call.name)?.check(call) ?? `unknown tool "${call.name}"`,
    describe: (call) => owner(call.name)!.describe(call),
    run: (call, signal) => owner(call.name)!.run(call, signal),
  };
}

/** Checks required arguments against a JSON schema's top level; the server checks the rest. */
export function checkArgs(schema: Record<string, unknown>, args: Record<string, unknown>, name: string): string | null {
  if ("__unparsed" in args) return `the arguments for "${name}" were not valid JSON`;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((r): r is string => typeof r === "string") : [];
  for (const key of required) if (args[key] === undefined || args[key] === null) return `missing argument "${key}"`;
  return null;
}
