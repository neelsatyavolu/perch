/**
 * The OpenAI-compatible Chat Completions API: OpenRouter, Google Gemini (its OpenAI-compatible
 * endpoint), LM Studio, Ollama and any custom endpoint (spec 7.3, "more providers").
 */

import { openStream, redactSecrets, sseJson, upstreamMessage } from "./http";
import type { ProviderId } from "./ids";
import { PROVIDERS } from "./providers";
import { ModelError, parseArgs, type Message, type Model, type ToolCall, type TurnEvent, type TurnRequest } from "./types";

export type ChatCompletionsOptions = {
  provider: ProviderId;
  /** The API root, ending before `/chat/completions`. */
  baseUrl: string;
  model: string;
  /** Null when the endpoint needs no key (local servers). */
  apiKey: () => Promise<string | null>;
  /** How this provider takes reasoning effort; omitted when it does not. */
  effortParam?: "reasoning_effort" | "reasoning";
  headers?: Record<string, string>;
};

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatMessage = Record<string, unknown>;

const imagePart = (data: string): Part => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } });

function toolCallOut(call: ToolCall): Record<string, unknown> {
  return { id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) }, ...(call.meta ?? {}) };
}

/** Tool results must follow their assistant message directly, so screenshots go in one user message after them. */
export function toChatMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  let pending: string[] = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({ role: "user", content: [{ type: "text", text: pending.length > 1 ? "Screenshots from the last steps:" : "Screenshot from the last step:" }, ...pending.map(imagePart)] });
    pending = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.callId, content: m.content });
      if (m.image) pending = [...pending, m.image];
      continue;
    }
    flush();
    if (m.role === "user") out.push({ role: "user", content: m.image ? [{ type: "text", text: m.text }, imagePart(m.image)] : m.text });
    else out.push({ role: "assistant", content: m.text || null, ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map(toolCallOut) } : {}) });
  }
  flush();
  return out;
}

type PendingCall = { id: string; name: string; json: string; meta?: Record<string, unknown> };

/** Servers that omit `index` start a call with an id and continue it without one. */
function mergeToolDelta(calls: Map<number, PendingCall>, delta: any): Map<number, PendingCall> {
  const last = Math.max(-1, ...calls.keys());
  const index = typeof delta?.index === "number" ? delta.index : (delta?.id || last < 0) ? last + 1 : last;
  const prev = calls.get(index) ?? { id: "", name: "", json: "" };
  const next: PendingCall = {
    id: delta?.id || prev.id,
    name: delta?.function?.name || prev.name,
    json: prev.json + (typeof delta?.function?.arguments === "string" ? delta.function.arguments : ""),
    ...(delta?.extra_content || prev.meta ? { meta: delta?.extra_content ? { extra_content: delta.extra_content } : prev.meta } : {}),
  };
  return new Map(calls).set(index, next);
}

export function chatCompletionsModel(opts: ChatCompletionsOptions, fetchImpl: typeof fetch = fetch): Model {
  const label = PROVIDERS[opts.provider].label;
  let effortRejected = false;
  return {
    id: `${opts.provider}:${opts.model}`,
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<TurnEvent> {
      const key = await opts.apiKey();
      let effort = effortRejected || !opts.effortParam ? undefined : req.effort;
      const build = () => {
        const effortField = !effort ? {} : opts.effortParam === "reasoning" ? { reasoning: { effort } } : { reasoning_effort: effort };
        const body = {
          model: opts.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: toChatMessages(req.system, req.messages),
          ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: "auto" } : {}),
          ...effortField,
        };
        const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...(opts.headers ?? {}) };
        if (key) headers.authorization = `Bearer ${key}`;
        return { url: `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, init: { method: "POST", headers, body: JSON.stringify(body) } };
      };
      const hint = key ? `Check the ${label} key in Perch's settings.` : `${label} refused the request. Check its settings.`;
      const stream = await openStream(build, {
        fetch: fetchImpl,
        signal,
        describe: (status, text) => upstreamMessage(status, text, hint),
        adjust: (text) => {
          if (!effort || !/effort|reasoning/i.test(text)) return false;
          effort = undefined;
          effortRejected = true;
          return true;
        },
      });
      let calls = new Map<number, PendingCall>();
      let usage: { input: number; output: number } | undefined;
      let finished = false;
      const clean = (message: string) => (key ? redactSecrets(message).split(key).join("[redacted]") : redactSecrets(message));
      for await (const chunk of sseJson(stream, signal)) {
        if (chunk?.error) throw new ModelError(clean(String(chunk.error.message ?? chunk.error ?? "The model failed.")));
        if (chunk?.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
        const choice = chunk?.choices?.[0];
        if (choice?.finish_reason) finished = true;
        const delta = choice?.delta;
        if (typeof delta?.content === "string" && delta.content) yield { type: "text", delta: delta.content };
        if (Array.isArray(delta?.tool_calls)) {
          for (const d of delta.tool_calls) calls = mergeToolDelta(calls, d);
        }
      }
      // A stream cut off before its finish reason may hold half a tool call: never run it.
      if (!finished) throw new ModelError("The model stopped before finishing. Try again.");
      const ordered = [...calls.entries()].sort(([a], [b]) => a - b);
      for (const [index, c] of ordered) {
        if (!c.name) continue;
        yield { type: "tool_call", call: { id: c.id || `call_${index}`, name: c.name, args: parseArgs(c.json), ...(c.meta ? { meta: c.meta } : {}) } };
      }
      yield usage ? { type: "done", usage } : { type: "done" };
    },
  };
}
