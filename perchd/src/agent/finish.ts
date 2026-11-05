/**
 * The final answer guarantee: when a task runs out of steps or time, the model gets one last turn
 * with tools switched off and is asked for its best answer from what it has verified. A partial,
 * honest answer is worth far more to the user than "stopped after 40 steps".
 */

import type { Effort, Message, Model, ToolSpec } from "../models/types";

export type Exhausted = "steps" | "time";

export function outOfBudget(why: Exhausted): string {
  const what = why === "steps" ? "steps" : "time";
  return [
    `You have run out of ${what} for this task, so you cannot use the browser any more.`,
    "Answer now in plain words with everything the pages you opened have shown: the facts the task asks for, and how far you got.",
    "Say clearly which parts are unverified or missing. Do not fill gaps from memory.",
  ].join(" ");
}

/** Runs the last turn and yields its text as it streams. Returns the whole answer ("" if none). */
export async function* finalTurn(opts: {
  model: Model;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  why: Exhausted;
  effort?: Effort;
  signal: AbortSignal;
}): AsyncGenerator<{ type: "text"; delta: string }, string> {
  let text = "";
  const messages: Message[] = [...opts.messages, { role: "user", text: outOfBudget(opts.why) }];
  try {
    // The tools stay listed (earlier turns used them) but the model may not call one.
    for await (const event of opts.model.turn({ system: opts.system, messages, tools: opts.tools, effort: opts.effort, toolChoice: "none" }, opts.signal)) {
      if (event.type !== "text") continue;
      text += event.delta;
      yield event;
    }
  } catch {
    return text.trim();
  }
  return text.trim();
}
