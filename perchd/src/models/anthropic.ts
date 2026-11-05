/** The Anthropic Messages API, for people who use a Claude API key (spec 7.3). */

import { openStream, redactSecrets, sseJson, upstreamMessage } from "./http";
import { ModelError, parseArgs, type Message, type Model, type TurnEvent, type TurnRequest } from "./types";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 8192;

type Block = Record<string, unknown>;

const imageBlock = (data: string): Block => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });

/** Tool results go back in a user message; consecutive results share one. */
export function toAnthropicMessages(messages: Message[]): { role: "user" | "assistant"; content: Block[] }[] {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const content: Block[] = m.text ? [{ type: "text", text: m.text }] : [];
      for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content });
      continue;
    }
    const block: Block =
      m.role === "user"
        ? { type: "text", text: m.text }
        : { type: "tool_result", tool_use_id: m.callId, content: [{ type: "text", text: m.content }, ...(m.image ? [imageBlock(m.image)] : [])] };
    const extra = m.role === "user" && m.image ? [imageBlock(m.image)] : [];
    const last = out.at(-1);
    if (last?.role === "user" && m.role === "tool") last.content.push(block);
    else out.push({ role: "user", content: [block, ...extra] });
  }
  return out;
}

export function anthropicModel(opts: { model: string; apiKey: () => Promise<string>; url?: string }, fetchImpl: typeof fetch = fetch): Model {
  return {
    id: `anthropic:${opts.model}`,
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<TurnEvent> {
      const key = await opts.apiKey();
      const body = {
        model: opts.model,
        max_tokens: MAX_TOKENS,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        // One action at a time, as with the Responses adapter: each result is checked before the next.
        ...(req.tools.length ? { tool_choice: { type: "auto", disable_parallel_tool_use: true } } : {}),
        stream: true,
      };
      const stream = await openStream(
        () => ({
          url: opts.url ?? ANTHROPIC_URL,
          init: {
            method: "POST",
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify(body),
          },
        }),
        { fetch: fetchImpl, signal, describe: (status, text) => upstreamMessage(status, text, "Check the Claude API key in Perch's settings.") },
      );
      const tools = new Map<number, { id: string; name: string; json: string }>();
      let input = 0;
      let output = 0;
      for await (const event of sseJson(stream, signal)) {
        switch (event.type) {
          case "message_start":
            input = event.message?.usage?.input_tokens ?? 0;
            break;
          case "content_block_start":
            if (event.content_block?.type === "tool_use") tools.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta" && event.delta.text) yield { type: "text", delta: event.delta.text };
            if (event.delta?.type === "input_json_delta") {
              const tool = tools.get(event.index);
              if (tool) tool.json += event.delta.partial_json ?? "";
            }
            break;
          case "content_block_stop": {
            const tool = tools.get(event.index);
            if (tool) yield { type: "tool_call", call: { id: tool.id, name: tool.name, args: parseArgs(tool.json) } };
            break;
          }
          case "message_delta":
            output = event.usage?.output_tokens ?? output;
            break;
          case "message_stop":
            yield { type: "done", usage: { input, output } };
            return;
          case "error":
            throw new ModelError(redactSecrets(String(event.error?.message ?? "The model failed.")).split(key).join("[redacted]"));
        }
      }
      throw new ModelError("The model stopped before finishing. Try again.");
    },
  };
}
