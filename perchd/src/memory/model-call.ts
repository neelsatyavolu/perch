/** One model turn that should answer by calling a single tool. Used by extraction, dreaming and setup. */

import type { Model, ToolSpec } from "../models/types";

export type ToolAnswer = { args: Record<string, unknown> | null; text: string };

export async function askForTool(model: Model, req: { system: string; user: string; tool: ToolSpec }, signal?: AbortSignal): Promise<ToolAnswer> {
  let text = "";
  let args: Record<string, unknown> | null = null;
  const turn = model.turn({ system: req.system, messages: [{ role: "user", text: req.user }], tools: [req.tool], effort: "low" }, signal ?? new AbortController().signal);
  for await (const event of turn) {
    if (event.type === "text") text += event.delta;
    else if (event.type === "tool_call" && event.call.name === req.tool.name && args === null) args = event.call.args;
  }
  return { args, text };
}

/** A string field from untrusted model output, or "" when it is not a string. */
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
