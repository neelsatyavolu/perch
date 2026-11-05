import { afterEach, expect, test } from "bun:test";
import { anthropicModel } from "../src/models/anthropic";
import { responsesModel } from "../src/models/responses";
import type { Model, TurnRequest } from "../src/models/types";
import { fakeServer, json, sse, type FakeServer } from "./fixtures/fake-providers";

const REQ: TurnRequest = { system: "You are Perch.", messages: [{ role: "user", text: "hi" }], tools: [], effort: "xhigh" };
const DONE = [{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } }];

let server: FakeServer | null = null;
afterEach(() => server?.stop());

async function run(model: Model): Promise<void> {
  for await (const _ of model.turn(REQ, new AbortController().signal)) {
    /* drain */
  }
}

test("the OpenAI API with a key: its own URL, typed content, no ChatGPT headers", async () => {
  server = fakeServer(() => sse(DONE));
  const model = responsesModel({ provider: "openai", model: "gpt-6-astra", url: `${server.url}/v1/responses`, getToken: async () => ({ accessToken: "sk-openai-0123456789abcdef" }) });
  expect(model.id).toBe("openai:gpt-6-astra");
  await run(model);
  const req = server.seen[0]!;
  expect(req.path).toBe("/v1/responses");
  expect(req.headers.authorization).toBe("Bearer sk-openai-0123456789abcdef");
  expect(req.headers.originator).toBeUndefined();
  expect(req.body).toMatchObject({ model: "gpt-6-astra", instructions: "You are Perch.", reasoning: { effort: "xhigh" } });
  expect(req.body.input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "hi" }] });
});

test("a rejected OpenAI key says to check the key, not to sign in", async () => {
  server = fakeServer(() => json({ error: { message: "Incorrect API key" } }, 401));
  const model = responsesModel({ provider: "openai", model: "gpt-6-astra", url: server.url, getToken: async () => ({ accessToken: "sk-openai-0123456789abcdef" }) });
  await expect(run(model)).rejects.toThrow("Check the OpenAI key");
});

test("xAI with an API key uses the Grok request shape at the given URL", async () => {
  server = fakeServer(() => sse(DONE));
  const model = responsesModel({ provider: "grok", model: "grok-4.7", url: `${server.url}/v1/responses`, label: "xAI", getToken: async () => ({ accessToken: "xai-0123456789abcdef" }) });
  await run(model);
  expect(server.seen[0]!.body.input[0]).toEqual({ role: "system", content: "You are Perch." });
});

test("the Anthropic adapter can point at another URL", async () => {
  server = fakeServer(() =>
    sse([{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_stop" }]),
  );
  await run(anthropicModel({ model: "claude-haiku-5-5", apiKey: async () => "sk-ant-0123456789", url: `${server.url}/v1/messages` }));
  expect(server.seen[0]!.path).toBe("/v1/messages");
});
