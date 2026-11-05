/** Shapes shared by the agent loop and the model adapters. Every model sees the same tools. */

/** `meta` carries provider data that must go back with the call, such as Gemini's thought signatures. */
export type ToolCall = { id: string; name: string; args: Record<string, unknown>; meta?: Record<string, unknown> };
export type ToolSpec = { name: string; description: string; parameters: object };
export type Effort = "low" | "medium" | "high" | "xhigh";

export type Message =
  | { role: "user"; text: string; image?: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string; image?: string };

export type TurnRequest = { system: string; messages: Message[]; tools: ToolSpec[]; effort?: Effort };

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; usage?: { input: number; output: number } };

export interface Model {
  id: string;
  turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<TurnEvent>;
}

export class ModelError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "ModelError";
  }
}

/** Parses tool-call arguments; bad JSON is kept so the tool layer can report it to the model. */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { __unparsed: raw };
  } catch {
    return { __unparsed: raw };
  }
}
