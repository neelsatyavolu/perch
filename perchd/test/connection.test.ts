import { afterEach, expect, test } from "bun:test";
import { fetchModelList } from "../src/models/connection";
import { fakeServer, json, type FakeServer } from "./fixtures/fake-providers";

let server: FakeServer | null = null;
afterEach(() => server?.stop());

const routes = (keyStatus: number) =>
  fakeServer((req) => (req.path === "/api/v1/key" ? json({ data: {} }, keyStatus) : json({ data: [{ id: "acme/one", supported_parameters: ["tools"] }] })));

test("OpenRouter's key is checked on its own endpoint, since its model list is public", async () => {
  server = routes(401);
  await expect(fetchModelList({ provider: "openrouter", baseUrl: `${server.url}/api/v1`, credential: "sk-or-bad-0123456789", fetch })).rejects.toThrow("OpenRouter rejected that key");
  expect(server.seen.map((s) => s.path)).toEqual(["/api/v1/key"]);
});

test("a good OpenRouter key lists models", async () => {
  server = routes(200);
  const models = await fetchModelList({ provider: "openrouter", baseUrl: `${server.url}/api/v1`, credential: "sk-or-good-0123456789", fetch });
  expect(models.map((m) => m.id)).toEqual(["acme/one"]);
  expect(server.seen[0]!.headers.authorization).toBe("Bearer sk-or-good-0123456789");
});

test("a server that answers with HTML is reported as unreadable", async () => {
  server = fakeServer(() => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
  await expect(fetchModelList({ provider: "custom", baseUrl: server.url, credential: null, fetch })).rejects.toThrow("could not read");
});

test("a gateway error names the provider and hides keys in its message", async () => {
  server = fakeServer(() => json({ error: { message: "upstream failed for key sk-live-0123456789abcdef" } }, 502));
  const error = await fetchModelList({ provider: "custom", baseUrl: server.url, credential: null, fetch }).catch((e: Error) => e);
  expect(String(error)).toContain("OpenAI-compatible endpoint answered with an error (HTTP 502)");
  expect(String(error)).not.toContain("sk-live");
});

test("LM Studio's own API fills in context size and vision for its models", async () => {
  server = fakeServer((req) => {
    if (req.path === "/v1/models") return json({ data: [{ id: "qwen3-coder" }, { id: "gemma-4-vision" }, { id: "unlisted" }] });
    if (req.path === "/api/v0/models") return json({ data: [{ id: "qwen3-coder", type: "llm", max_context_length: 262144 }, { id: "gemma-4-vision", type: "vlm", max_context_length: 131072 }] });
    return json({}, 404);
  });
  const models = await fetchModelList({ provider: "lmstudio", baseUrl: `${server.url}/v1`, credential: null, fetch });
  expect(models.map((m) => [m.id, m.context, m.vision])).toEqual([["qwen3-coder", 262144, false], ["gemma-4-vision", 131072, true], ["unlisted", null, false]]);
});

test("Ollama's show endpoint gives context size (num_ctx first), tools and vision", async () => {
  server = fakeServer((req) => {
    if (req.path === "/v1/models") return json({ data: [{ id: "qwen3:8b" }, { id: "mystery:1b" }, { id: "broken:1b" }] });
    if (req.path === "/api/show" && req.body?.model === "qwen3:8b") return json({ model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 }, parameters: "num_ctx 16384\ntemperature 0.6", capabilities: ["completion", "tools"] });
    if (req.path === "/api/show" && req.body?.model === "mystery:1b") return json({ model_info: { "general.architecture": "llama", "llama.context_length": 8192 }, capabilities: ["completion", "vision"] });
    return json({ error: "not found" }, 404);
  });
  const models = await fetchModelList({ provider: "ollama", baseUrl: `${server.url}/v1`, credential: null, fetch });
  expect(models.map((m) => [m.id, m.context, m.tools, m.vision])).toEqual([
    ["qwen3:8b", 16384, true, false],
    ["mystery:1b", 8192, false, true],
    ["broken:1b", null, true, false],
  ]);
});

test("a local server whose native API is missing still lists its models", async () => {
  server = fakeServer((req) => (req.path === "/v1/models" ? json({ data: [{ id: "qwen3:8b" }] }) : new Response("nope", { status: 404 })));
  const models = await fetchModelList({ provider: "ollama", baseUrl: `${server.url}/v1`, credential: null, fetch });
  expect(models.map((m) => [m.id, m.context])).toEqual([["qwen3:8b", null]]);
});
