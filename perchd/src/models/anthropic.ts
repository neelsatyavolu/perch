/**
 * The Anthropic Messages API, for a Claude API key (spec 7.3) or a Claude Pro or Max sign-in. A
 * sign-in's requests are shaped by shared-ai-auth's claudeRequest, which the subscription backend
 * requires.
 */

import { CLAUDE_CODE_VERSION, claudeRequest, claudeRequiredVersion } from "@neelsatyavolu/shared-ai-auth";
import { openStream, redactSecrets, sseJson, upstreamMessage } from "./http";
import { ModelError, parseArgs, type Message, type Model, type TurnEvent, type TurnRequest } from "./types";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
/** Room for adaptive thinking before the answer or tool call; streaming keeps a large value safe. */
const MAX_TOKENS = 32_000;
/** Fast mode (research preview; Claude Opus 5.5, Opus 5 and Opus 4.8 on the Claude API, at a higher price). */
const FAST_BETA = "fast-mode-2026-02-01";

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

/** `oauth` (a Claude sign-in's access token) takes the place of `apiKey`. */
export function anthropicModel(
  opts: { model: string; apiKey?: () => Promise<string>; oauth?: () => Promise<string>; url?: string; fast?: boolean },
  fetchImpl: typeof fetch = fetch,
): Model {
  // Once the API rejects the effort or fast setting for this model (older models have none), stop sending it.
  let effortRejected = false;
  let fastRejected = false;
  // The Claude Code version a sign-in's requests advertise; raised once when a model needs a newer one.
  let version = CLAUDE_CODE_VERSION;
  const signedIn = Boolean(opts.oauth);
  return {
    id: `${signedIn ? "claude" : "anthropic"}:${opts.model}`,
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<TurnEvent> {
      const key = await (opts.oauth ?? opts.apiKey ?? (() => Promise.reject(new ModelError("No Claude key or sign-in."))))();
      // The Claude API takes low through max; "none" (a Responses API value) has no Claude equivalent.
      let effort = effortRejected || req.effort === "none" ? undefined : req.effort;
      let fast = Boolean(opts.fast) && !fastRejected;
      const body = () => ({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        ...toolChoice(req),
        ...(effort ? { output_config: { effort } } : {}),
        ...(fast ? { speed: "fast" } : {}),
        // Caches the conversation up to the newest block, so each step re-reads the prefix cheaply.
        cache_control: { type: "ephemeral" },
        stream: true,
      });
      const request = () => {
        if (signedIn) {
          const shaped = claudeRequest(body(), { accessToken: key, version, betas: fast ? [FAST_BETA] : [], url: opts.url ?? ANTHROPIC_URL, entrypoint: "perch" });
          return { url: shaped.url, init: { method: "POST", headers: { ...shaped.headers, accept: "text/event-stream" }, body: JSON.stringify(shaped.body) } };
        }
        return {
          url: opts.url ?? ANTHROPIC_URL,
          init: {
            method: "POST",
            headers: {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
              accept: "text/event-stream",
              ...(fast ? { "anthropic-beta": FAST_BETA } : {}),
            },
            body: JSON.stringify(body()),
          },
        };
      };
      const stream = await openStream(
        request,
        {
          fetch: fetchImpl,
          signal,
          describe: (status, text) => upstreamMessage(status, text, signedIn ? "Sign in to Claude again in Settings → Models." : "Check the Claude API key in Perch's settings."),
          adjust: (text) => {
            // The subscription backend gates new models on the advertised Claude Code version.
            const needed = signedIn ? claudeRequiredVersion(text) : null;
            if (needed && needed !== version) {
              version = needed;
              return true;
            }
            if (fast && /speed|fast/i.test(text)) {
              fast = false;
              fastRejected = true;
              return true;
            }
            if (!effort || !/effort|output_config/i.test(text)) return false;
            effort = undefined;
            effortRejected = true;
            return true;
          },
        },
      );
      yield* readStream(stream, signal, key);
    },
  };
}

/** One action at a time, as with the Responses adapter: each result is checked before the next. */
function toolChoice(req: TurnRequest): object {
  if (!req.tools.length) return {};
  return req.toolChoice === "none" ? { tool_choice: { type: "none" } } : { tool_choice: { type: "auto", disable_parallel_tool_use: true } };
}

async function* readStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal, key: string): AsyncIterable<TurnEvent> {
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
        if (event.delta?.stop_reason === "refusal") throw new ModelError("Claude declined to continue this task. Try rewording it, or use another model.");
        break;
      case "message_stop":
        yield { type: "done", usage: { input, output } };
        return;
      case "error":
        throw new ModelError(redactSecrets(String(event.error?.message ?? "The model failed.")).split(key).join("[redacted]"));
    }
  }
  throw new ModelError("The model stopped before finishing. Try again.");
}
