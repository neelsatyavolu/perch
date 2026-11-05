import { afterEach, expect, test } from "bun:test";
import { chatCompletionsModel } from "../src/models/chat-completions";
import type { Model, TurnEvent, TurnRequest } from "../src/models/types";
import { fakeServer, json, sse, type FakeServer } from "./fixtures/fake-providers";

const KEY = "sk-or-SECRET-0123456789";
const REQ: TurnRequest = {
  system: "You are Perch.",
  messages: [
    { role: "user", text: "Open mail" },
    { role: "assistant", text: "Opening.", toolCalls: [{ id: "c1", name: "navigate", args: { url: "https://mailroom.app" }, meta: { extra_content: { google: { thought_signature: "sig-1" } } } }] },
    { role: "tool", callId: "c1", name: "navigate", content: "opened", image: "AAAA" },
  ],
  tools: [{ name: "navigate", description: "Open a URL", parameters: { type: "object", properties: { url: { type: "string" } } } }],
  effort: "high",
};

let server: FakeServer | null = null;
afterEach(() => server?.stop());

async function collect(model: Model, req: TurnRequest = REQ): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of model.turn(req, new AbortController().signal)) out.push(e);
  return out;
}

const STREAM = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "Look" } }] },
  { choices: [{ index: 0, delta: { content: "ing." } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "click", arguments: "" }, extra_content: { google: { thought_signature: "sig-2" } } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"ref":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"e4"}' } }] }, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } },
];

test("streams text and a tool call; sends tools, images and thought signatures back", async () => {
  server = fakeServer(() => sse(STREAM));
  const model = chatCompletionsModel({ provider: "gemini", baseUrl: `${server.url}/v1beta/openai`, model: "gemini-3.8-flash", apiKey: async () => KEY, effortParam: "reasoning_effort" });
  expect(model.id).toBe("gemini:gemini-3.8-flash");
  expect(await collect(model)).toEqual([
    { type: "text", delta: "Look" },
    { type: "text", delta: "ing." },
    { type: "tool_call", call: { id: "call_9", name: "click", args: { ref: "e4" }, meta: { extra_content: { google: { thought_signature: "sig-2" } } } } },
    { type: "done", usage: { input: 50, output: 7 } },
  ]);
  const req = server.seen[0]!;
  expect(req.path).toBe("/v1beta/openai/chat/completions");
  expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
  expect(req.body).toMatchObject({ model: "gemini-3.8-flash", stream: true, reasoning_effort: "high", tool_choice: "auto" });
  expect(req.body.tools[0]).toEqual({ type: "function", function: { name: "navigate", description: "Open a URL", parameters: REQ.tools[0]!.parameters } });
  expect(req.body.messages).toEqual([
    { role: "system", content: "You are Perch." },
    { role: "user", content: "Open mail" },
    {
      role: "assistant",
      content: "Opening.",
      tool_calls: [{ id: "c1", type: "function", function: { name: "navigate", arguments: '{"url":"https://mailroom.app"}' }, extra_content: { google: { thought_signature: "sig-1" } } }],
    },
    { role: "tool", tool_call_id: "c1", content: "opened" },
    { role: "user", content: [{ type: "text", text: "Screenshot from the last step:" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] },
  ]);
});

test("a local server without a key gets no Authorization header and no effort field", async () => {
  server = fakeServer(() => sse([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]));
  const model = chatCompletionsModel({ provider: "ollama", baseUrl: `${server.url}/v1`, model: "qwen3:8b", apiKey: async () => null });
  expect(await collect(model)).toEqual([{ type: "text", delta: "hi" }, { type: "done" }]);
  expect(server.seen[0]!.headers.authorization).toBeUndefined();
  expect(server.seen[0]!.body.reasoning_effort).toBeUndefined();
});

test("OpenRouter's effort goes in a reasoning object", async () => {
  server = fakeServer(() => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));
  const model = chatCompletionsModel({ provider: "openrouter", baseUrl: server.url, model: "acme/x", apiKey: async () => KEY, effortParam: "reasoning" });
  await collect(model);
  expect(server.seen[0]!.body.reasoning).toEqual({ effort: "high" });
});

test("a 400 about reasoning retries once without effort", async () => {
  let n = 0;
  server = fakeServer(() => (n++ === 0 ? json({ error: { message: "reasoning_effort is not supported" } }, 400) : sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const model = chatCompletionsModel({ provider: "custom", baseUrl: server.url, model: "m", apiKey: async () => KEY, effortParam: "reasoning_effort" });
  await collect(model);
  expect(server.seen).toHaveLength(2);
  expect(server.seen[1]!.body.reasoning_effort).toBeUndefined();
});

test("a 401 names the provider and never repeats the key", async () => {
  server = fakeServer(() => json({ error: { message: `bad key ${KEY}` } }, 401));
  const model = chatCompletionsModel({ provider: "openrouter", baseUrl: server.url, model: "acme/x", apiKey: async () => KEY });
  const error = await collect(model).catch((e: Error) => e);
  expect(String(error)).toContain("OpenRouter key");
  expect(String(error)).not.toContain(KEY);
});

test("an error body in the stream is thrown in plain words", async () => {
  server = fakeServer(() => sse([{ error: { message: "model not loaded" } }]));
  const model = chatCompletionsModel({ provider: "lmstudio", baseUrl: server.url, model: "m", apiKey: async () => null });
  await expect(collect(model)).rejects.toThrow("model not loaded");
});
