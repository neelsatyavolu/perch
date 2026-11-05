/** The OpenAI Responses API: Codex (ChatGPT sign-in), Grok (xAI sign-in or key) and the OpenAI API (key). */

import { openStream, redactSecrets, sseJson, upstreamMessage, type Attempt } from "./http";
import { ModelError, parseArgs, type Effort, type Message, type Model, type ToolSpec, type TurnEvent, type TurnRequest } from "./types";

export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
export const GROK_URL = "https://api.x.ai/v1/responses";
export const OPENAI_URL = "https://api.openai.com/v1/responses";

export type ResponsesTokens = { accessToken: string; accountId?: string };
export type ResponsesProvider = "codex" | "grok" | "openai";
export type ResponsesOptions = {
  provider: ResponsesProvider;
  model: string;
  getToken: () => Promise<ResponsesTokens>;
  /** Overrides the provider's endpoint (tests, or a gateway). */
  url?: string;
  /** Names the provider in key errors, such as "xAI" for a Grok API key. */
  label?: string;
};

function inputItems(provider: ResponsesProvider, messages: Message[]): object[] {
  const text = (role: "user" | "assistant", value: string) =>
    provider === "grok" ? value : [{ type: role === "user" ? "input_text" : "output_text", text: value }];
  const items: object[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({
        role: "user",
        content: m.image
          ? [{ type: "input_text", text: m.text }, { type: "input_image", image_url: `data:image/jpeg;base64,${m.image}` }]
          : text("user", m.text),
      });
    } else if (m.role === "assistant") {
      if (m.text) items.push({ role: "assistant", content: text("assistant", m.text) });
      for (const c of m.toolCalls) items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
    } else {
      items.push({ type: "function_call_output", call_id: m.callId, output: m.content });
      if (m.image) {
        items.push({
          role: "user",
          content: [{ type: "input_text", text: "Screenshot from the last step:" }, { type: "input_image", image_url: `data:image/jpeg;base64,${m.image}` }],
        });
      }
    }
  }
  return items;
}

function tools(specs: ToolSpec[]): object[] {
  return specs.map((s) => ({ type: "function", name: s.name, description: s.description, parameters: s.parameters, strict: false }));
}

function build(opts: ResponsesOptions, tokens: ResponsesTokens, req: TurnRequest, effort: Effort | undefined): Attempt {
  const base = { model: opts.model, store: false, stream: true, tools: tools(req.tools), tool_choice: "auto", parallel_tool_calls: false };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (opts.provider !== "grok") {
    if (opts.provider === "codex") {
      headers.originator = "codex_cli_rs";
      headers["OpenAI-Beta"] = "responses=v1";
      if (tokens.accountId) headers["chatgpt-account-id"] = tokens.accountId;
    }
    const openaiEffort = effort === "max" ? "xhigh" : effort;
    const body = { ...base, instructions: req.system, input: inputItems(opts.provider, req.messages), ...(openaiEffort ? { reasoning: { effort: openaiEffort } } : {}) };
    return { url: opts.url ?? (opts.provider === "codex" ? CODEX_URL : OPENAI_URL), init: { method: "POST", headers, body: JSON.stringify(body) } };
  }
  headers["User-Agent"] = "grok-cli/1.0";
  const input = [{ role: "system", content: req.system }, ...inputItems("grok", req.messages)];
  // xAI takes low, medium or high.
  const grokEffort = effort === "xhigh" || effort === "max" ? "high" : effort === "none" ? undefined : effort;
  const body = { ...base, input, ...(grokEffort && /^grok-4/.test(opts.model) ? { reasoning: { effort: grokEffort } } : {}) };
  return { url: opts.url ?? GROK_URL, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

export function responsesModel(opts: ResponsesOptions, fetchImpl: typeof fetch = fetch): Model {
  const signIn =
    opts.provider === "openai" || opts.label
      ? `Check the ${opts.label ?? "OpenAI"} key in Perch's settings.`
      : opts.provider === "codex"
        ? "Sign in to ChatGPT again in Perch's settings."
        : "Sign in to Grok again in Perch's settings.";
  // Once the provider rejects reasoning effort for this model, stop sending it.
  let effortRejected = false;
  return {
    id: `${opts.provider}:${opts.model}`,
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<TurnEvent> {
      const tokens = await opts.getToken();
      let effort = effortRejected ? undefined : req.effort;
      const body = await openStream(() => build(opts, tokens, req, effort), {
        fetch: fetchImpl,
        signal,
        describe: (status, text) => upstreamMessage(status, text, signIn),
        adjust: (text) => {
          if (!effort || !/effort|reasoning/i.test(text)) return false;
          effort = undefined;
          effortRejected = true;
          return true;
        },
      });
      for await (const event of sseJson(body, signal)) {
        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta) yield { type: "text", delta: event.delta };
            break;
          case "response.output_item.done":
            if (event.item?.type === "function_call") {
              yield { type: "tool_call", call: { id: event.item.call_id, name: event.item.name, args: parseArgs(event.item.arguments ?? "") } };
            }
            break;
          case "response.completed":
          case "response.incomplete": {
            const usage = event.response?.usage;
            yield { type: "done", usage: usage ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } : undefined };
            return;
          }
          case "response.failed":
          case "error":
            throw new ModelError(redactSecrets(String(event.response?.error?.message ?? event.error?.message ?? event.message ?? "The model failed.")).split(tokens.accessToken).join("[redacted]"));
        }
      }
      throw new ModelError("The model stopped before finishing. Try again.");
    },
  };
}
