/** Shapes shared by the agent loop and the model adapters. */

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
