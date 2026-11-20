/** Shapes shared by the agent loop and the model adapters. Every model sees the same tools. */

/** `meta` carries provider data that must go back with the call, such as Gemini's thought signatures. */
export type ToolCall = { id: string; name: string; args: Record<string, unknown>; meta?: Record<string, unknown> };
export type ToolSpec = { name: string; description: string; parameters: object };
/** Reasoning effort as an API takes it: "none" is the Responses API's lowest, "max" the Claude API's highest. */
export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type Message =
  | { role: "user"; text: string; image?: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string; image?: string };

/** toolChoice "none" asks for an answer in text only, as in the final turn of a task. */
export type TurnRequest = { system: string; messages: Message[]; tools: ToolSpec[]; effort?: Effort; toolChoice?: "auto" | "none" };

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

/**
 * An image's media type from its bytes (base64). Providers reject an image whose stated type is
 * not what it is, and a file's extension (a PNG saved as .jpg) or a tool's guess can be wrong.
 */
export function imageMediaType(data: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR") && Buffer.from(data.slice(0, 16), "base64").subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "image/jpeg";
}
