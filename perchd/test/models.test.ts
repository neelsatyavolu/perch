import { expect, test } from "bun:test";
import { anthropicModel } from "../src/models/anthropic";
import { fakeModel } from "../src/models/fake";
import { responsesModel } from "../src/models/responses";
import type { Model, TurnEvent, TurnRequest } from "../src/models/types";

const TOKEN = "tok-SECRET-1234567890";
const REQ: TurnRequest = {
  system: "You are Perch.",
  messages: [
    { role: "user", text: "Open mail" },
    { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "navigate", args: { url: "https://mailroom.app" } }] },
    { role: "tool", callId: "call_1", name: "navigate", content: "opened mailroom.app", image: "AAAA" },
  ],
  tools: [{ name: "navigate", description: "Open a URL", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } }],
  effort: "high",
};

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

function fakeFetch(responses: { status: number; body: string }[], seen: { url: string; init: RequestInit }[] = []): typeof fetch {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    // Split the body into small chunks to exercise the SSE splitter.
    const bytes = new TextEncoder().encode(r.body);
    const stream = new ReadableStream({
      start(controller) {
        for (let k = 0; k < bytes.length; k += 17) controller.enqueue(bytes.subarray(k, k + 17));
        controller.close();
      },
    });
    return new Response(stream, { status: r.status });
  }) as unknown as typeof fetch;
}

async function collect(model: Model, req: TurnRequest = REQ): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of model.turn(req, new AbortController().signal)) out.push(event);
  return out;
}

const RESPONSES_STREAM = sse([
  { type: "response.output_text.delta", delta: "Opening " },
  { type: "response.output_text.delta", delta: "mail." },
  { type: "response.output_item.done", item: { type: "function_call", call_id: "call_2", name: "snapshot", arguments: "{}" } },
  { type: "response.completed", response: { usage: { input_tokens: 120, output_tokens: 9 } } },
]);

test("Codex: text deltas, one tool call, usage", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = responsesModel({ provider: "codex", model: "gpt-6-astra", getToken: async () => ({ accessToken: TOKEN, accountId: "acct_9" }) }, fakeFetch([{ status: 200, body: RESPONSES_STREAM }], seen));
  expect(await collect(model)).toEqual([
    { type: "text", delta: "Opening " },
    { type: "text", delta: "mail." },
    { type: "tool_call", call: { id: "call_2", name: "snapshot", args: {} } },
    { type: "done", usage: { input: 120, output: 9 } },
  ]);
  expect(seen[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  const headers = seen[0]!.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(headers.originator).toBe("codex_cli_rs");
  expect(headers["chatgpt-account-id"]).toBe("acct_9");
  const body = JSON.parse(String(seen[0]!.init.body));
  expect(body).toMatchObject({ model: "gpt-6-astra", instructions: "You are Perch.", store: false, stream: true, parallel_tool_calls: false, reasoning: { effort: "high" } });
  expect(body.tools[0]).toEqual({ type: "function", name: "navigate", description: "Open a URL", parameters: REQ.tools[0]!.parameters, strict: false });
  expect(body.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "Open mail" }] },
    { type: "function_call", call_id: "call_1", name: "navigate", arguments: '{"url":"https://mailroom.app"}' },
    { type: "function_call_output", call_id: "call_1", output: "opened mailroom.app" },
    { role: "user", content: [{ type: "input_text", text: "Screenshot from the last step:" }, { type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "high" }] },
  ]);
});

test("Grok: system goes first in the input, same events", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = responsesModel({ provider: "grok", model: "grok-4.7", getToken: async () => ({ accessToken: TOKEN }) }, fakeFetch([{ status: 200, body: RESPONSES_STREAM }], seen));
  expect((await collect(model)).at(-1)).toEqual({ type: "done", usage: { input: 120, output: 9 } });
  expect(seen[0]!.url).toBe("https://api.x.ai/v1/responses");
  const body = JSON.parse(String(seen[0]!.init.body));
  expect(body.input[0]).toEqual({ role: "system", content: "You are Perch." });
  expect(body.instructions).toBeUndefined();
});

test("a 400 about reasoning effort retries once without effort", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = responsesModel({ provider: "codex", model: "gpt-6-luna", getToken: async () => ({ accessToken: TOKEN }) },
    fakeFetch([{ status: 400, body: '{"error":{"message":"Unsupported value: reasoning.effort"}}' }, { status: 200, body: RESPONSES_STREAM }], seen));
  await collect(model);
  expect(seen).toHaveLength(2);
  expect(JSON.parse(String(seen[1]!.init.body)).reasoning).toBeUndefined();
});

test("a 401 asks the user to sign in again and never repeats the token", async () => {
  const model = responsesModel({ provider: "codex", model: "gpt-6-astra", getToken: async () => ({ accessToken: TOKEN }) },
    fakeFetch([{ status: 401, body: `{"error":{"message":"invalid token ${TOKEN}"}}` }]));
  const error = await collect(model).catch((e: Error) => e);
  expect(String(error)).toContain("Sign in to ChatGPT again");
  expect(String(error)).not.toContain(TOKEN);
});

test("a stream error event becomes a thrown error", async () => {
  const model = responsesModel({ provider: "grok", model: "grok-4.7", getToken: async () => ({ accessToken: TOKEN }) },
    fakeFetch([{ status: 200, body: sse([{ type: "response.failed", response: { error: { message: "The model is overloaded." } } }]) }]));
  await expect(collect(model)).rejects.toThrow("The model is overloaded.");
});

const ANTHROPIC_STREAM = sse([
  { type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "click", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"ref":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"e12"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 31 } },
  { type: "message_stop" },
]);

test("Anthropic: text, a streamed tool call, usage, and the request shape", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = anthropicModel({ model: "claude-opus-5-5", apiKey: async () => "sk-ant-SECRET" }, fakeFetch([{ status: 200, body: ANTHROPIC_STREAM }], seen));
  expect(await collect(model)).toEqual([
    { type: "text", delta: "Checking." },
    { type: "tool_call", call: { id: "toolu_1", name: "click", args: { ref: "e12" } } },
    { type: "done", usage: { input: 200, output: 31 } },
  ]);
  expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  const headers = seen[0]!.init.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("sk-ant-SECRET");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  const body = JSON.parse(String(seen[0]!.init.body));
  expect(body).toMatchObject({ model: "claude-opus-5-5", system: "You are Perch.", stream: true });
  expect(body.tools[0]).toEqual({ name: "navigate", description: "Open a URL", input_schema: REQ.tools[0]!.parameters });
  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Open mail" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "navigate", input: { url: "https://mailroom.app" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "opened mailroom.app" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] }] },
  ]);
});

test("Anthropic: effort, prompt caching, room for thinking, one tool call at a time", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = anthropicModel({ model: "claude-opus-5-5", apiKey: async () => "sk-ant-SECRET" }, fakeFetch([{ status: 200, body: ANTHROPIC_STREAM }], seen));
  await collect(model);
  const body = JSON.parse(String(seen[0]!.init.body));
  expect(body.output_config).toEqual({ effort: "high" });
  expect(body.cache_control).toEqual({ type: "ephemeral" });
  expect(body.max_tokens).toBeGreaterThanOrEqual(32_000);
  expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  expect(body.thinking).toBeUndefined();
});

test("Anthropic: the final turn asks for text only, and a model without effort is retried without it", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = anthropicModel({ model: "claude-haiku-4-5", apiKey: async () => "sk-ant-SECRET" },
    fakeFetch([{ status: 400, body: '{"error":{"message":"output_config.effort: This model does not support the effort parameter."}}' }, { status: 200, body: ANTHROPIC_STREAM }], seen));
  await collect(model, { ...REQ, toolChoice: "none" });
  expect(seen).toHaveLength(2);
  const retry = JSON.parse(String(seen[1]!.init.body));
  expect(retry.output_config).toBeUndefined();
  expect(retry.tool_choice).toEqual({ type: "none" });
  await collect(model);
  expect(JSON.parse(String(seen[2]!.init.body)).output_config).toBeUndefined();
});

test("Anthropic: a refusal ends the turn with a plain message", async () => {
  const refusal = sse([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
  const model = anthropicModel({ model: "claude-opus-5-5", apiKey: async () => "k" }, fakeFetch([{ status: 200, body: refusal }]));
  await expect(collect(model)).rejects.toThrow("Claude declined to continue this task");
});

test("Responses: the final turn asks for text only, and screenshots go at high detail", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = responsesModel({ provider: "codex", model: "gpt-6-astra", getToken: async () => ({ accessToken: TOKEN }) }, fakeFetch([{ status: 200, body: RESPONSES_STREAM }], seen));
  await collect(model, { ...REQ, toolChoice: "none" });
  const body = JSON.parse(String(seen[0]!.init.body));
  expect(body.tool_choice).toBe("none");
  expect(body.input.at(-1).content[1]).toEqual({ type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "high" });
});

test("Anthropic: the effort goes in output_config; a 400 about it retries once without", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = anthropicModel({ model: "claude-opus-5-5", apiKey: async () => "sk-ant-SECRET" },
    fakeFetch([{ status: 200, body: ANTHROPIC_STREAM }, { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"output_config.effort: unsupported value"}}' }, { status: 200, body: ANTHROPIC_STREAM }], seen));
  await collect(model, { ...REQ, effort: "max" });
  expect(JSON.parse(String(seen[0]!.init.body)).output_config).toEqual({ effort: "max" });
  await collect(model, { ...REQ, effort: "low" });
  expect(seen).toHaveLength(3);
  expect(JSON.parse(String(seen[2]!.init.body)).output_config).toBeUndefined();
  await collect(model, { ...REQ, effort: undefined });
  expect(JSON.parse(String(seen[3]!.init.body)).output_config).toBeUndefined();
});

test("Anthropic fast mode: speed and its beta header; a 400 about it retries once at normal speed", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = anthropicModel({ model: "claude-opus-5-5", apiKey: async () => "sk-ant-SECRET", fast: true },
    fakeFetch([{ status: 200, body: ANTHROPIC_STREAM }, { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"speed: fast mode is not available for this model"}}' }, { status: 200, body: ANTHROPIC_STREAM }], seen));
  await collect(model);
  expect(JSON.parse(String(seen[0]!.init.body)).speed).toBe("fast");
  expect((seen[0]!.init.headers as Record<string, string>)["anthropic-beta"]).toBe("fast-mode-2026-02-01");
  await collect(model);
  expect(seen).toHaveLength(3);
  expect(JSON.parse(String(seen[2]!.init.body)).speed).toBeUndefined();
  expect((seen[2]!.init.headers as Record<string, string>)["anthropic-beta"]).toBeUndefined();
});

test("Responses: \"none\" reaches OpenAI as the lowest reasoning effort; Grok gets no effort it cannot take", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const openai = responsesModel({ provider: "openai", model: "gpt-6-astra", getToken: async () => ({ accessToken: TOKEN }) }, fakeFetch([{ status: 200, body: RESPONSES_STREAM }], seen));
  await collect(openai, { ...REQ, effort: "none" });
  expect(JSON.parse(String(seen[0]!.init.body)).reasoning).toEqual({ effort: "none" });
  const grok = responsesModel({ provider: "grok", model: "grok-4.7", getToken: async () => ({ accessToken: TOKEN }) }, fakeFetch([{ status: 200, body: RESPONSES_STREAM }], seen));
  await collect(grok, { ...REQ, effort: "none" });
  expect(JSON.parse(String(seen[1]!.init.body)).reasoning).toBeUndefined();
  await collect(grok, { ...REQ, effort: "max" });
  expect(JSON.parse(String(seen[2]!.init.body)).reasoning).toEqual({ effort: "high" });
});

test("the fake model plays its script and records requests", async () => {
  const model = fakeModel([[{ type: "text", delta: "hi" }, { type: "done" }]]);
  expect(await collect(model)).toEqual([{ type: "text", delta: "hi" }, { type: "done" }]);
  expect(model.requests).toHaveLength(1);
  await expect(collect(model)).rejects.toThrow("the fake model's script ran out");
});

test("a Claude sign-in sends its requests the way the subscription backend needs, and follows its version gate", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const model = anthropicModel(
    { model: "claude-fable-5-2", oauth: async () => "sk-ant-oat01-TOKEN" },
    fakeFetch([{ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.322 does not support this model; version 2.1.400 or newer is required."}}' }, { status: 200, body: ANTHROPIC_STREAM }], seen),
  );
  const events = [];
  for await (const e of model.turn({ system: "You are Perch.", messages: [{ role: "user", text: "Find the cheapest SSD" }], tools: [] }, new AbortController().signal)) events.push(e);
  expect(events.at(-1)?.type).toBe("done");
  expect(seen).toHaveLength(2);
  const headers = seen[1]!.init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer sk-ant-oat01-TOKEN");
  expect(headers["x-api-key"]).toBeUndefined();
  expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  expect(headers["user-agent"]).toBe("claude-cli/2.1.400 (external, perch)");
  const body = JSON.parse(String(seen[1]!.init.body));
  expect(body.system[0].text).toStartWith("x-anthropic-billing-header: cc_version=2.1.400.");
  expect(body.system[1].text).toBe("You are Perch.");
  expect(model.id).toBe("claude:claude-fable-5-2");
});
